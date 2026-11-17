import { createHash } from "node:crypto";

import type { PgBoss } from "pg-boss";

import { JOB_RETRY_OPTIONS } from "./enqueue-job.js";
import { type JobAlertTier, type JobOwner, ownershipOf } from "./job-ownership.js";
import { DEAD_LETTER_QUEUE } from "./job-queues.js";

/**
 * The job id a replay of one dead-letter entry is sent with. It is derived
 * from the entry's id, so replaying the same entry twice sends the same id,
 * and pg-boss's insert (ON CONFLICT DO NOTHING) drops the second send while
 * the first replayed job is still kept. A replay that dead-letters again gets
 * a new dead-letter entry, and so a new id of its own.
 */
export function replayJobIdFor(deadLetterJobId: string): string {
  const hex = createHash("sha256").update(`dead-letter-replay:${deadLetterJobId}`).digest("hex");
  // Shaped as an RFC 9562 version 8 (custom) UUID: pg-boss's id column is uuid.
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type DeadLetterReplayRefusal = {
  ok: false;
  reason: "not_found" | "no_source" | "unknown_queue" | "scheduled_queue" | "already_replayed";
  detail: string;
};

export type DeadLetterReplayPlan = {
  ok: true;
  deadLetterJobId: string;
  queue: string;
  sourceJobId: string | null;
  owner: JobOwner;
  tier: JobAlertTier;
  attempts: number | null;
  replayJobId: string;
  // Key names only: the values can be personal data and are never printed.
  payloadKeys: string[];
  data: unknown;
};

/**
 * Reads one dead-letter entry and decides whether it may be replayed. Read
 * only. Only event queues are replayed: a scheduled job's next tick is its
 * retry, so replaying one only runs a stale tick, and an unknown queue has no
 * known idempotency contract. Event consumers must be safe to run up to 17
 * times (enqueue-job.ts), which is what makes one more run safe.
 */
export async function planDeadLetterReplay(
  boss: PgBoss,
  deadLetterJobId: string,
): Promise<DeadLetterReplayPlan | DeadLetterReplayRefusal> {
  const entry = await boss.getJobById<unknown>(DEAD_LETTER_QUEUE, deadLetterJobId);
  if (entry === null) {
    return {
      ok: false,
      reason: "not_found",
      detail: `No ${DEAD_LETTER_QUEUE} entry ${deadLetterJobId}; it is kept for 30 days after it lands`,
    };
  }
  const queue = entry.sourceName;
  if (typeof queue !== "string" || queue.length === 0) {
    return { ok: false, reason: "no_source", detail: "The entry has no source queue recorded, so there is nowhere to replay it" };
  }
  const ownership = ownershipOf(queue);
  if (!ownership.known) {
    return { ok: false, reason: "unknown_queue", detail: `${queue} is not in JOB_QUEUE_OWNERSHIP; replay is refused` };
  }
  if (ownership.kind === "scheduled") {
    return {
      ok: false,
      reason: "scheduled_queue",
      detail: `${queue} is a scheduled queue: its next tick re-runs the work, so it is not replayed`,
    };
  }
  const replayJobId = replayJobIdFor(entry.id);
  const existing = await boss.getJobById<unknown>(queue, replayJobId);
  if (existing !== null) {
    return {
      ok: false,
      reason: "already_replayed",
      detail: `Already replayed as ${queue} job ${replayJobId} (state: ${existing.state})`,
    };
  }
  const retryCount = typeof entry.sourceRetryCount === "number" ? entry.sourceRetryCount : null;
  return {
    ok: true,
    deadLetterJobId: entry.id,
    queue,
    sourceJobId: entry.sourceId ?? null,
    owner: ownership.owner,
    tier: ownership.tier,
    attempts: retryCount === null ? null : retryCount + 1,
    replayJobId,
    payloadKeys:
      typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data)
        ? Object.keys(entry.data).sort()
        : [],
    data: entry.data,
  };
}

/**
 * Sends the dead-lettered payload, unchanged, back to its source queue with
 * the event retry profile and the dead-letter queue, as a new job with the
 * plan's deterministic id. "already_replayed" means another replay of the
 * same entry got there first.
 */
export async function replayDeadLetterJob(
  boss: PgBoss,
  plan: DeadLetterReplayPlan,
): Promise<{ status: "sent"; jobId: string } | { status: "already_replayed"; jobId: string }> {
  const sent = await boss.send(plan.queue, plan.data as object, {
    ...JOB_RETRY_OPTIONS,
    deadLetter: DEAD_LETTER_QUEUE,
    id: plan.replayJobId,
  });
  return sent === null ? { status: "already_replayed", jobId: plan.replayJobId } : { status: "sent", jobId: sent };
}

import type { PgBoss } from "pg-boss";

import { JOB_RETRY_OPTIONS, SCHEDULED_JOB_RETRY_OPTIONS } from "./enqueue-job.js";

// Where a job goes when it fails after its last retry (ASYNC_JOBS.md:
// "Repeated max-attempt exhaustion -> Dead-letter with alert"). One shared
// queue for every other queue: the worker's consumer
// (dead-letter-consumer.ts) logs which queue each entry came from, so
// alerting can route on that.
export const DEAD_LETTER_QUEUE = "maintenance.dead_letter";

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

// pg-boss keeps a dead-lettered payload for the queue's retention window
// while it waits to be consumed, and for deleteAfterSeconds once the consumer
// has completed it (its defaults are 14 and 7 days). The payload is what a
// manual replay is built from, so it is kept for 30 days to leave time to
// triage and replay.
export const DEAD_LETTER_QUEUE_OPTIONS = {
  retentionSeconds: THIRTY_DAYS_SECONDS,
  deleteAfterSeconds: THIRTY_DAYS_SECONDS,
} as const;

/**
 * "event": enqueued by application code, once per occurrence (long retry
 * profile). "scheduled": fired by a boss.schedule cron entry (short retry
 * profile, because the next tick is the real retry).
 */
export type JobQueueKind = "event" | "scheduled";

function jobQueueOptions(kind: JobQueueKind) {
  return {
    ...(kind === "event" ? JOB_RETRY_OPTIONS : SCHEDULED_JOB_RETRY_OPTIONS),
    deadLetter: DEAD_LETTER_QUEUE,
  };
}

/**
 * Must run, on every start of every process that creates queues, before any
 * ensureJobQueue call: a queue's deadLetter is a foreign key to this queue.
 */
export async function ensureDeadLetterQueue(boss: PgBoss): Promise<void> {
  await boss.createQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_QUEUE_OPTIONS);
  await boss.updateQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_QUEUE_OPTIONS);
}

/**
 * Creates the queue if it is missing and brings its dead-letter queue and
 * retry settings up to date if it is not. createQueue is ON CONFLICT DO
 * NOTHING, so on its own it never touches a queue created by an earlier
 * release; updateQueue is what reaches those. Safe to run on every start.
 *
 * pg-boss copies a queue's retry and dead-letter settings onto each job when
 * the job is sent, so this affects jobs sent after it runs. A job already
 * waiting in the queue keeps the settings it was sent with.
 */
export async function ensureJobQueue(boss: PgBoss, name: string, kind: JobQueueKind): Promise<void> {
  const options = jobQueueOptions(kind);
  await boss.createQueue(name, options);
  await boss.updateQueue(name, options);
}

import type { PgBoss } from "pg-boss";

import type { Prisma } from "../../generated/prisma/client.js";

// Retry profile for event jobs: one-shot jobs enqueued by application code
// (the Didit webhook, the offering/escrow/post-IPO handoffs, the
// reconfirmation notification) that no schedule re-creates, so a job that
// exhausts its retries is lost unless someone replays it from the dead-letter
// queue (ASYNC_JOBS.md: "Repeated max-attempt exhaustion -> Dead-letter with
// alert"). The earlier baseline of 5 retries with no retryDelay spent all of
// them within 31-62 seconds, which any provider or database blip longer than
// a minute outlasts.
//
// pg-boss waits min(retryDelayMax, retryDelay * 2^(n-1) * (1 + random())) before
// retry n. With retryDelay 30 and retryDelayMax 900 the 16 waits are 30-60 s,
// 60-120 s, 120-240 s, 240-480 s and 480-900 s, then eleven waits of exactly
// 900 s: between 10,830 s (3.0 h) and 11,700 s (3.25 h) in total whatever the
// jitter. That rides out an outage of two hours with an hour to spare, and the
// 15 minute cap bounds how long a recovered dependency waits for its next
// attempt. Every consumer of these jobs must be safe to run up to 17 times.
export const JOB_RETRY_OPTIONS = {
  retryLimit: 16,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 900,
} as const;

// Retry profile for cron-scheduled jobs (worker.ts's boss.schedule calls): the
// earlier baseline, 5 retries over 31-62 seconds. A scheduled job needs no
// long horizon because its next tick is the real retry, and a long one would
// stack up a backlog of retry runs behind a failing every-minute job.
export const SCHEDULED_JOB_RETRY_OPTIONS = { retryLimit: 5, retryBackoff: true } as const;

/**
 * The one shared cross-domain enqueue path (AD-145, AD-152): every call site
 * hands over a queue name, a payload, and the trace_id of the request that
 * triggered the work, and this is the only place that injects trace_id into
 * the job and binds the send to the caller's own Prisma transaction (via
 * pg-boss's per-call `db` adapter) so the job is durably queued in the same
 * database transaction as the state change that created it — never a
 * separate step that could succeed or fail independently of it.
 */
export async function enqueueTransactionalJob(
  boss: PgBoss,
  transaction: Prisma.TransactionClient,
  queueName: string,
  data: Record<string, unknown>,
  traceId: string,
): Promise<string | null> {
  return boss.send(
    queueName,
    { ...data, trace_id: traceId },
    {
      ...JOB_RETRY_OPTIONS,
      db: {
        executeSql: async (text: string, values?: unknown[]) => ({
          rows: await transaction.$queryRawUnsafe<unknown[]>(text, ...(values ?? [])),
        }),
      },
    },
  );
}

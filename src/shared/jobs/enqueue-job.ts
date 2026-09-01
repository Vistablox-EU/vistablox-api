import type { PgBoss } from "pg-boss";

import type { Prisma } from "../../generated/prisma/client.js";

// AD-135 / ASYNC_JOBS.md's retry baseline: up to 5 attempts, exponential
// backoff with jitter (pg-boss's own retryBackoff formula already includes
// jitter). Shared with worker.ts's scheduled jobs so both paths agree.
export const JOB_RETRY_OPTIONS = { retryLimit: 5, retryBackoff: true } as const;

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
): Promise<void> {
  await boss.send(
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

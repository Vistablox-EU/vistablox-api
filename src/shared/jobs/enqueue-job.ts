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

/**
 * The publish-side sibling of enqueueTransactionalJob, for topics with zero
 * or more subscribers rather than one fixed queue name (pg-boss's own
 * publish/subscribe primitive: boss.publish() looks up every queue currently
 * subscribed to `event` and calls send() for each). Confirmed directly
 * against pg-boss's own source (node_modules/pg-boss/dist/manager.js) that
 * the same transaction-bound `db` adapter used here is forwarded correctly
 * to every one of those fanned-out send() calls, not just a single one --
 * the subscriber *lookup* itself runs outside the transaction, on pg-boss's
 * own connection, but that's immaterial here since subscriptions are static
 * ops config set once via boss.subscribe() at process startup, never created
 * or changed mid-transaction.
 */
export async function publishTransactionalEvent(
  boss: PgBoss,
  transaction: Prisma.TransactionClient,
  event: string,
  data: Record<string, unknown>,
  traceId: string,
): Promise<void> {
  await boss.publish(
    event,
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

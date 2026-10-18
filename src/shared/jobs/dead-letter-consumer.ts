import type { Logger } from "pino";
import type { JobWithMetadata, PgBoss } from "pg-boss";

import { DEAD_LETTER_QUEUE } from "./job-queues.js";

const MAX_LAST_ERROR_LENGTH = 500;

// The camelCase key is the Didit webhook payload's own (its payload is built
// in PrismaKycRepository.enqueueDiditWebhookProcessing); every job sent
// through enqueueTransactionalJob carries snake_case trace_id (AD-152).
function traceIdOf(data: unknown): string {
  if (typeof data !== "object" || data === null) return "unknown";
  const payload = data as { trace_id?: unknown; traceId?: unknown };
  if (typeof payload.trace_id === "string") return payload.trace_id;
  if (typeof payload.traceId === "string") return payload.traceId;
  return "unknown";
}

function messageOf(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const { message, value } = output as { message?: unknown; value?: unknown };
  // A throwing handler's Error is stored as the failed job's output as it is.
  if (typeof message === "string") return message;
  // Anything else is wrapped as { value } by pg-boss: a non-Error throw or a
  // string passed to fail() as { value: "..." }, and its own timeout and
  // heartbeat failures as { value: { message: "job timed out" } }.
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const wrapped = (value as { message?: unknown }).message;
    if (typeof wrapped === "string") return wrapped;
  }
  return null;
}

function lastErrorOf(output: unknown): string | null {
  return messageOf(output)?.slice(0, MAX_LAST_ERROR_LENGTH) ?? null;
}

/**
 * Logs one error-level line for every job that failed after its last retry.
 * That line is the alert hook (ALERTING.md: a dead-letter job alerts; LOGGING_STRATEGY.md:
 * "a pg-boss job exhausting retries into dead-letter" is an `error`): alert on
 * the message, route on `job`. The payload is deliberately not logged, only
 * the identifiers needed to find it; the dead-letter queue keeps the payload.
 */
export function createDeadLetterHandler(
  logger: Logger,
): (jobs: JobWithMetadata<unknown>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      // The retries the original job consumed; one more than that is how many
      // times it actually ran.
      const retryCount = typeof job.sourceRetryCount === "number" ? job.sourceRetryCount : null;
      logger.error(
        {
          job: job.sourceName ?? "unknown",
          job_id: job.sourceId ?? "unknown",
          dead_letter_job_id: job.id,
          trace_id: traceIdOf(job.data),
          retry_count: retryCount,
          attempts: retryCount === null ? null : retryCount + 1,
          last_error: lastErrorOf(job.output),
        },
        "job dead-lettered after exhausting retries",
      );
    }
  };
}

/**
 * The worker-side consumer of the dead-letter queue. pg-boss completes an entry
 * only after the handler returns, so an entry is logged at least once (a crash
 * between the log line and the completion logs it again), not exactly once; the
 * payload stays in the dead-letter queue (see DEAD_LETTER_QUEUE_OPTIONS) to
 * replay from.
 */
export async function registerDeadLetterConsumer(boss: PgBoss, logger: Logger): Promise<void> {
  await boss.work(DEAD_LETTER_QUEUE, { includeMetadata: true }, createDeadLetterHandler(logger));
}

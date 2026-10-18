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

// pg-boss stores a throwing handler's error as the failed job's output.
function lastErrorOf(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const message = (output as { message?: unknown }).message;
  return typeof message === "string" ? message.slice(0, MAX_LAST_ERROR_LENGTH) : null;
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
 * The worker-side consumer of the dead-letter queue. It completes each entry
 * once logged, so an entry is logged once; the payload stays in the dead-letter
 * queue (see DEAD_LETTER_QUEUE_OPTIONS) to replay from.
 */
export async function registerDeadLetterConsumer(boss: PgBoss, logger: Logger): Promise<void> {
  await boss.work(DEAD_LETTER_QUEUE, { includeMetadata: true }, createDeadLetterHandler(logger));
}

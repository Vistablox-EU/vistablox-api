import type { Logger } from "pino";
import type { JobWithMetadata, PgBoss } from "pg-boss";

import { stripUrls } from "../logging/log-redaction.js";
import type { DeliverDeadLetterAlert } from "./dead-letter-alert-webhook.js";
import { ownershipOf } from "./job-ownership.js";
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

// A failed job's output can carry the RPC URL (a viem error puts "URL: <url>" in
// its message), whose path holds the provider's API key, and this line is the
// retained, alert-hook copy of the failure, so it must not be the place a key
// ends up in logs. URLs are stripped before the text is truncated so that a long
// URL costs the 500 characters one "[url]" and not its own length: the text
// after it (a viem error's "Details:" line, the reason for the failure) is kept.
// Secrecy does not depend on the order: a prefix cut out of a URL either still
// has its "scheme://" and is stripped, or has not reached the path and holds no
// key.
function lastErrorOf(output: unknown): string | null {
  const message = messageOf(output);
  return message === null ? null : stripUrls(message).slice(0, MAX_LAST_ERROR_LENGTH);
}

/**
 * Logs one error-level line for every job that failed after its last retry,
 * then hands the same facts to `deliverAlert` (the dead-letter alert webhook,
 * when one is configured). The line is the alert hook either way (ALERTING.md:
 * a dead-letter job alerts; LOGGING_STRATEGY.md: "a pg-boss job exhausting
 * retries into dead-letter" is an `error`): alert on `event`, route on `owner`
 * and `tier` (job-ownership.ts). The payload is deliberately neither logged nor
 * sent, only the identifiers needed to find it; the dead-letter queue keeps the
 * payload.
 */
export function createDeadLetterHandler(
  logger: Logger,
  options: { deliverAlert?: DeliverDeadLetterAlert } = {},
): (jobs: JobWithMetadata<unknown>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      // The retries the original job consumed; one more than that is how many
      // times it actually ran.
      const retryCount = typeof job.sourceRetryCount === "number" ? job.sourceRetryCount : null;
      const queue = job.sourceName ?? "unknown";
      const ownership = ownershipOf(queue);
      const fields = {
        job: queue,
        job_id: job.sourceId ?? "unknown",
        dead_letter_job_id: job.id,
        trace_id: traceIdOf(job.data),
        owner: ownership.owner,
        tier: ownership.tier,
        retry_count: retryCount,
        attempts: retryCount === null ? null : retryCount + 1,
        last_error: lastErrorOf(job.output),
      };
      logger.error(
        { event: "job.dead_lettered", severity: "error", ...fields },
        "job dead-lettered after exhausting retries",
      );
      if (options.deliverAlert !== undefined) {
        const { retry_count: _retryCount, ...alert } = fields;
        // A delivery failure must not fail the entry: the line above is the
        // record, and a throw would log this entry again on every retry. The
        // webhook sender never throws; this guards any other sender.
        try {
          await options.deliverAlert({ ...alert, replayable: ownership.known && ownership.kind === "event" });
        } catch {
          logger.warn(
            {
              event: "job.dead_letter_alert_delivery_failed",
              severity: "warning",
              job: queue,
              dead_letter_job_id: job.id,
            },
            "dead-letter alert delivery threw",
          );
        }
      }
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
export async function registerDeadLetterConsumer(
  boss: PgBoss,
  logger: Logger,
  options: { deliverAlert?: DeliverDeadLetterAlert } = {},
): Promise<void> {
  await boss.work(DEAD_LETTER_QUEUE, { includeMetadata: true }, createDeadLetterHandler(logger, options));
}

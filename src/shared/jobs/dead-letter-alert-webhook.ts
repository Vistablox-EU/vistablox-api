import type { Logger } from "pino";

import { maskLongHexValues, stripUrls } from "../logging/log-redaction.js";
import type { JobAlertTier, JobOwner } from "./job-ownership.js";

export const DEAD_LETTER_ALERT_TIMEOUT_MS = 5000;

/**
 * What a dead-letter alert says. Identifiers, ownership and a redacted failure
 * summary only: never the job payload, which can hold personal data and stays
 * in the dead-letter queue.
 */
export type DeadLetterAlert = {
  job: string;
  job_id: string;
  dead_letter_job_id: string;
  trace_id: string;
  owner: JobOwner;
  tier: JobAlertTier;
  replayable: boolean;
  attempts: number | null;
  last_error: string | null;
};

export type DeliverDeadLetterAlert = (alert: DeadLetterAlert) => Promise<void>;

const EMAIL_ADDRESS = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;

// last_error already has its URLs stripped for the log line. A chat channel
// is a wider audience than the log store, so long hex values (wallet
// addresses, transaction hashes) and email addresses a provider or database
// error may quote are masked here too.
function redactForChannel(text: string): string {
  return maskLongHexValues(stripUrls(text)).replace(EMAIL_ADDRESS, "[email]");
}

export function deadLetterAlertPayload(alert: DeadLetterAlert): {
  text: string;
  dead_letter: DeadLetterAlert;
} {
  const lastError = alert.last_error === null ? null : redactForChannel(alert.last_error);
  const attempts = alert.attempts === null ? "unknown" : String(alert.attempts);
  const lines = [
    `:rotating_light: [${alert.tier}] Job dead-lettered: ${alert.job} (owner: ${alert.owner})`,
    `job_id: ${alert.job_id} | dead_letter_job_id: ${alert.dead_letter_job_id} | attempts: ${attempts} | trace_id: ${alert.trace_id}`,
    `last_error: ${lastError ?? "none recorded"}`,
    alert.replayable
      ? `Replay: npm run jobs:replay-dead-letter -- --dead-letter-job-id ${alert.dead_letter_job_id} (dry run first; see docs/dead-letter-jobs.md)`
      : "Not replayable (scheduled or unknown queue); see docs/dead-letter-jobs.md",
  ];
  return { text: lines.join("\n"), dead_letter: { ...alert, last_error: lastError } };
}

/**
 * POSTs the alert as JSON to one webhook URL. The body is a Slack incoming
 * webhook message (`text`) with the structured alert alongside it under
 * `dead_letter`, so a Slack channel shows it as is and any other receiver
 * (an email relay, PagerDuty via a transform) can read the fields.
 *
 * Delivery is best effort and never throws: a failure is logged and the
 * consumer moves on, because the error-level dead-letter line has already
 * been written and stays the record. The URL is a credential and never
 * appears in a log line.
 */
export function createDeadLetterAlertWebhook(options: {
  url: string;
  logger: Logger;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): DeliverDeadLetterAlert {
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEAD_LETTER_ALERT_TIMEOUT_MS;
  return async (alert) => {
    try {
      const response = await send(options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(deadLetterAlertPayload(alert)),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      // The body is not read: a receiver's error text can echo the request.
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        options.logger.warn(
          {
            event: "job.dead_letter_alert_delivery_failed",
            severity: "warning",
            job: alert.job,
            dead_letter_job_id: alert.dead_letter_job_id,
            http_status: response.status,
          },
          "dead-letter alert webhook rejected the alert",
        );
      }
    } catch (error) {
      options.logger.warn(
        {
          event: "job.dead_letter_alert_delivery_failed",
          severity: "warning",
          job: alert.job,
          dead_letter_job_id: alert.dead_letter_job_id,
          error_name: error instanceof Error ? error.name : "unknown",
          error_message: error instanceof Error ? stripUrls(error.message).slice(0, 200) : "non-error value thrown",
        },
        "dead-letter alert webhook could not be reached",
      );
    }
  };
}

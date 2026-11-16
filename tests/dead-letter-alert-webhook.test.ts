import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  createDeadLetterAlertWebhook,
  type DeadLetterAlert,
  deadLetterAlertPayload,
} from "../src/shared/jobs/dead-letter-alert-webhook.js";

const WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/SECRETWEBHOOKTOKEN";

function alert(overrides: Partial<DeadLetterAlert> = {}): DeadLetterAlert {
  return {
    job: "settlement.open_ipo_escrow_campaign",
    job_id: "source-job-1",
    dead_letter_job_id: "dlq-job-1",
    trace_id: "req_trace_1",
    owner: "settlement",
    tier: "tier_1",
    replayable: true,
    attempts: 17,
    last_error: "execution reverted",
    ...overrides,
  };
}

function fakeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { logger: { warn, error: vi.fn(), info: vi.fn() } as unknown as Logger, warn };
}

describe("dead-letter alert webhook", () => {
  it("builds a Slack text message plus the structured alert", () => {
    const payload = deadLetterAlertPayload(alert());

    expect(payload.text).toContain("[tier_1] Job dead-lettered: settlement.open_ipo_escrow_campaign (owner: settlement)");
    expect(payload.text).toContain("dead_letter_job_id: dlq-job-1");
    expect(payload.text).toContain("attempts: 17");
    expect(payload.text).toContain("npm run jobs:replay-dead-letter -- --dead-letter-job-id dlq-job-1");
    expect(payload.dead_letter).toEqual(alert());
  });

  it("says when a job is not replayable", () => {
    expect(deadLetterAlertPayload(alert({ replayable: false, attempts: null, last_error: null })).text).toMatch(
      /attempts: unknown[\s\S]*last_error: none recorded[\s\S]*Not replayable/,
    );
  });

  it("masks URLs, long hex values and email addresses in last_error for the channel", () => {
    const payload = deadLetterAlertPayload(
      alert({
        last_error: `wallet 0x${"ab".repeat(20)} of investor@example.com failed at https://rpc.example.org/v2/KEY`,
      }),
    );

    expect(payload.dead_letter.last_error).toBe("wallet 0xabab...abab of [email] failed at [url]");
    expect(JSON.stringify(payload)).not.toMatch(/investor@|KEY|abababababababab/);
  });

  it("POSTs the payload as JSON with a timeout and no redirects", async () => {
    const { logger, warn } = fakeLogger();
    const fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));

    await createDeadLetterAlertWebhook({ url: WEBHOOK_URL, logger, fetch })(alert());

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual(deadLetterAlertPayload(alert()));
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a non-2xx response without throwing and without the URL", async () => {
    const { logger, warn } = fakeLogger();
    const fetch = vi.fn().mockResolvedValue(new Response("invalid_token", { status: 403 }));

    await expect(createDeadLetterAlertWebhook({ url: WEBHOOK_URL, logger, fetch })(alert())).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      {
        event: "job.dead_letter_alert_delivery_failed",
        severity: "warning",
        job: "settlement.open_ipo_escrow_campaign",
        dead_letter_job_id: "dlq-job-1",
        http_status: 403,
      },
      "dead-letter alert webhook rejected the alert",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRETWEBHOOKTOKEN");
  });

  it("logs a network failure or timeout without throwing and without the URL", async () => {
    const { logger, warn } = fakeLogger();
    const fetch = vi.fn().mockRejectedValue(new TypeError(`fetch failed for ${WEBHOOK_URL}`));

    await expect(createDeadLetterAlertWebhook({ url: WEBHOOK_URL, logger, fetch })(alert())).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "job.dead_letter_alert_delivery_failed",
        error_name: "TypeError",
        error_message: "fetch failed for [url]",
      }),
      "dead-letter alert webhook could not be reached",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRETWEBHOOKTOKEN");
  });

  it("gives up after the timeout", async () => {
    const { logger, warn } = fakeLogger();
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

    await createDeadLetterAlertWebhook({ url: WEBHOOK_URL, logger, fetch: fetch as typeof globalThis.fetch, timeoutMs: 10 })(
      alert(),
    );

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error_name: "TimeoutError" }),
      "dead-letter alert webhook could not be reached",
    );
  });
});

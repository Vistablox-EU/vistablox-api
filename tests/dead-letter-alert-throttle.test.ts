import { describe, expect, it, vi } from "vitest";

import { throttleDeadLetterAlerts } from "../src/shared/jobs/dead-letter-alert-throttle.js";
import { type DeadLetterAlert, deadLetterAlertPayload } from "../src/shared/jobs/dead-letter-alert-webhook.js";

const MINUTE = 60_000;

function alert(job = "queue.a"): DeadLetterAlert {
  return {
    job,
    job_id: "source-job-1",
    dead_letter_job_id: "dlq-job-1",
    trace_id: "req_trace_1",
    owner: "settlement",
    tier: "tier_1",
    replayable: true,
    attempts: 17,
    last_error: "boom",
  };
}

function setup(windowMs = 60 * MINUTE) {
  let clock = 0;
  const deliver = vi.fn(async (_alert: DeadLetterAlert) => true);
  const send = throttleDeadLetterAlerts(deliver, { windowMs, now: () => clock });
  return { deliver, send, advance: (ms: number) => (clock += ms) };
}

describe("throttleDeadLetterAlerts", () => {
  it("alerts at once for the first dead letter of a queue, without a suppressed count", async () => {
    const { deliver, send } = setup();
    await send(alert());
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0].suppressed).toBeUndefined();
  });

  it("counts further dead letters of the queue inside the window instead of sending them", async () => {
    const { deliver, send, advance } = setup();
    await send(alert());
    advance(10 * MINUTE);
    await send(alert());
    await send(alert());
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("reports the count and the previous alert time on the first alert after the window", async () => {
    const { deliver, send, advance } = setup();
    await send(alert());
    advance(10 * MINUTE);
    await send(alert());
    await send(alert());
    advance(50 * MINUTE);
    await send(alert());
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]?.[0].suppressed).toEqual({ count: 2, since: new Date(0).toISOString() });
  });

  it("starts a fresh window after the later alert, with the count reset", async () => {
    const { deliver, send, advance } = setup();
    await send(alert());
    await send(alert());
    advance(60 * MINUTE);
    await send(alert());
    advance(60 * MINUTE);
    await send(alert());
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls[2]?.[0].suppressed).toBeUndefined();
  });

  it("keeps windows per source queue", async () => {
    const { deliver, send } = setup();
    await send(alert("queue.a"));
    await send(alert("queue.b"));
    await send(alert("queue.a"));
    expect(deliver.mock.calls.map((call) => call[0].job)).toEqual(["queue.a", "queue.b"]);
  });

  it("does not open a window for an alert the receiver did not take, and keeps the count", async () => {
    const { deliver, send, advance } = setup();
    await send(alert());
    advance(10 * MINUTE);
    await send(alert());
    advance(60 * MINUTE);
    deliver.mockResolvedValueOnce(false);
    await send(alert());
    await send(alert());
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls[2]?.[0].suppressed?.count).toBe(1);
    await send(alert());
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it("sends every alert when the window is 0", async () => {
    const { deliver, send } = setup(0);
    await send(alert());
    await send(alert());
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});

describe("deadLetterAlertPayload with a suppressed count", () => {
  it("adds an 'N more since <time>' line", () => {
    const since = new Date(0).toISOString();
    const { text } = deadLetterAlertPayload({ ...alert(), suppressed: { count: 4, since } });
    expect(text).toContain(`4 more of queue.a since ${since}`);
  });
});

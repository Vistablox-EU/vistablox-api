import type { Logger } from "pino";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

import { createDeadLetterHandler, registerDeadLetterConsumer } from "../src/shared/jobs/dead-letter-consumer.js";
import { DEAD_LETTER_QUEUE } from "../src/shared/jobs/job-queues.js";

function fakeLogger(): { logger: Logger; error: ReturnType<typeof vi.fn>; other: ReturnType<typeof vi.fn> } {
  const error = vi.fn();
  const other = vi.fn();
  const logger = { error, warn: other, info: other, debug: other, fatal: other } as unknown as Logger;
  return { logger, error, other };
}

// Overrides are loosely typed on purpose: a real row can carry nulls the
// declared JobWithMetadata type does not allow (a legacy entry with no source).
function deadLetterJob(overrides: Record<string, unknown> = {}): JobWithMetadata<unknown> {
  return {
    id: "dlq-job-1",
    name: DEAD_LETTER_QUEUE,
    data: { case_id: "case_1", trace_id: "req_trace_1" },
    sourceName: "case_timers.pre_offering_open_handoff",
    sourceId: "source-job-1",
    sourceRetryCount: 16,
    output: { message: "connect ECONNREFUSED 10.0.0.1:5432" },
    ...overrides,
  } as unknown as JobWithMetadata<unknown>;
}

describe("dead-letter consumer", () => {
  it("logs each dead-lettered job once, at error level, with its queue, ids, trace_id and attempt count", async () => {
    const { logger, error, other } = fakeLogger();

    await createDeadLetterHandler(logger)([deadLetterJob()]);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      {
        job: "case_timers.pre_offering_open_handoff",
        job_id: "source-job-1",
        dead_letter_job_id: "dlq-job-1",
        trace_id: "req_trace_1",
        retry_count: 16,
        attempts: 17,
        last_error: "connect ECONNREFUSED 10.0.0.1:5432",
      },
      "job dead-lettered after exhausting retries",
    );
    expect(other).not.toHaveBeenCalled();
  });

  it("reads the trace id from the camelCase key the Didit webhook payload uses", async () => {
    const { logger, error } = fakeLogger();

    await createDeadLetterHandler(logger)([
      deadLetterJob({
        sourceName: "provider_events.didit_webhook",
        data: { eventId: "evt_1", traceId: "req_didit_1" },
      }),
    ]);

    expect(error.mock.calls[0]?.[0]).toMatchObject({
      job: "provider_events.didit_webhook",
      trace_id: "req_didit_1",
    });
  });

  it("logs every job in a batch", async () => {
    const { logger, error } = fakeLogger();

    await createDeadLetterHandler(logger)([
      deadLetterJob({ id: "dlq-a", sourceId: "src-a" }),
      deadLetterJob({ id: "dlq-b", sourceId: "src-b" }),
    ]);

    expect(error.mock.calls.map((call) => (call[0] as { job_id: string }).job_id)).toEqual(["src-a", "src-b"]);
  });

  it("still logs, with explicit placeholders, when the payload, source or error output is missing", async () => {
    const { logger, error } = fakeLogger();

    await expect(
      createDeadLetterHandler(logger)([
        deadLetterJob({ data: null, sourceName: null, sourceId: null, sourceRetryCount: null, output: null }),
      ]),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toEqual({
      job: "unknown",
      job_id: "unknown",
      dead_letter_job_id: "dlq-job-1",
      trace_id: "unknown",
      retry_count: null,
      attempts: null,
      last_error: null,
    });
  });

  // pg-boss fails a job itself, with an output of the form { value: { message } },
  // when its handler outlives expireInSeconds (a worker killed mid-job by a
  // deploy or an OOM, or a hung handler) and when its heartbeat stops; and it
  // wraps anything that is not an object (a string passed to fail(), a
  // non-Error throw) as { value }.
  it.each([
    ["a job pg-boss timed out", { value: { message: "job timed out" } }, "job timed out"],
    ["a job whose heartbeat stopped", { value: { message: "job heartbeat timeout" } }, "job heartbeat timeout"],
    ["a non-Error throw", { value: "plain string failure" }, "plain string failure"],
  ])("keeps the cause when the failure output is pg-boss's wrapped form: %s", async (_label, output, expected) => {
    const { logger, error } = fakeLogger();

    await createDeadLetterHandler(logger)([deadLetterJob({ output })]);

    expect((error.mock.calls[0]?.[0] as { last_error: unknown }).last_error).toBe(expected);
  });

  it.each([
    ["a number", { value: 42 }],
    ["null", { value: null }],
    ["an object with no message", { value: { code: "E_X" } }],
    ["a blank output object", {}],
  ])("logs a null last_error rather than guessing when the output holds no message: %s", async (_label, output) => {
    const { logger, error } = fakeLogger();

    await createDeadLetterHandler(logger)([deadLetterJob({ output })]);

    expect((error.mock.calls[0]?.[0] as { last_error: unknown }).last_error).toBeNull();
  });

  it("truncates a very long last error", async () => {
    const { logger, error } = fakeLogger();

    await createDeadLetterHandler(logger)([deadLetterJob({ output: { message: "x".repeat(5_000) } })]);

    expect((error.mock.calls[0]?.[0] as { last_error: string }).last_error).toHaveLength(500);
  });

  it("registers a metadata-aware worker on the dead-letter queue whose handler logs", async () => {
    const { logger, error } = fakeLogger();
    const work = vi.fn().mockResolvedValue("worker-id");

    await registerDeadLetterConsumer({ work } as unknown as PgBoss, logger);

    expect(work).toHaveBeenCalledTimes(1);
    const [queueName, options, handler] = work.mock.calls[0] as [
      string,
      { includeMetadata?: boolean },
      (jobs: JobWithMetadata<unknown>[]) => Promise<void>,
    ];
    expect(queueName).toBe(DEAD_LETTER_QUEUE);
    // sourceName / sourceId / sourceRetryCount only come back with metadata.
    expect(options.includeMetadata).toBe(true);
    await handler([deadLetterJob()]);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

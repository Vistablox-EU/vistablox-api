import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGracefulShutdown,
  DEFAULT_SHUTDOWN_DEADLINE_MS,
  installProcessFaultHandlers,
  JOB_DRAIN_TIMEOUT_MS,
  type ShutdownStep,
} from "../src/shared/lifecycle/graceful-shutdown.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recordingLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() };
}

// The first argument of every call to one logger level, in order.
function logged(level: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return level.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

function messages(level: ReturnType<typeof vi.fn>): string[] {
  return level.mock.calls.map((call) => call[1] as string);
}

const quick = (name: string, order: string[]): ShutdownStep => ({
  name,
  close: () => {
    order.push(name);
  },
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createGracefulShutdown", () => {
  it("exits 0 once every step has closed, and starts the steps of one phase together", async () => {
    const logger = recordingLogger();
    const exit = vi.fn<(code: number) => void>();
    const first = deferred();
    const started: string[] = [];
    const shutdown = createGracefulShutdown({
      logger,
      exit,
      phases: [
        [
          { name: "a", close: () => { started.push("a"); return first.promise; } },
          { name: "b", close: () => { started.push("b"); } },
        ],
      ],
    });

    const done = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);

    expect(started).toEqual(["a", "b"]);
    expect(exit).not.toHaveBeenCalled();

    first.resolve();
    await done;

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
  });

  it("runs a phase only after the one before it has finished", async () => {
    const exit = vi.fn<(code: number) => void>();
    const requests = deferred();
    const order: string[] = [];
    const shutdown = createGracefulShutdown({
      logger: recordingLogger(),
      exit,
      phases: [
        [{ name: "http server", close: async () => { order.push("http server"); await requests.promise; order.push("requests done"); } }],
        [quick("database", order)],
      ],
    });

    const done = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual(["http server"]);

    requests.resolve();
    await done;

    expect(order).toEqual(["http server", "requests done", "database"]);
  });

  it("still waits for the other steps, and runs the later phases, when one step rejects", async () => {
    const logger = recordingLogger();
    const exit = vi.fn<(code: number) => void>();
    const slow = deferred();
    const order: string[] = [];
    const shutdown = createGracefulShutdown({
      logger,
      exit,
      phases: [
        [
          { name: "failing", close: async () => { order.push("failing"); throw new Error("boom"); } },
          { name: "slow", close: async () => { order.push("slow started"); await slow.promise; order.push("slow done"); } },
        ],
        [quick("after", order)],
      ],
    });

    const done = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);

    // The rejection has long happened; the exit must wait for the slow step.
    expect(order).toEqual(["failing", "slow started"]);
    expect(exit).not.toHaveBeenCalled();

    slow.resolve();
    await done;

    expect(order).toEqual(["failing", "slow started", "slow done", "after"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("logs every step that failed, by name, not only the first", async () => {
    const logger = recordingLogger();
    const exit = vi.fn<(code: number) => void>();
    const shutdown = createGracefulShutdown({
      logger,
      exit,
      phases: [
        [
          { name: "database", close: () => Promise.reject(new Error("database would not close")) },
          { name: "queue", close: () => Promise.reject(new Error("queue would not stop")) },
          { name: "cache", close: () => undefined },
        ],
      ],
    });

    await shutdown("SIGTERM");

    const failures = logged(logger.error);
    expect(failures.map((entry) => entry.step)).toEqual(["database", "queue"]);
    expect(failures.map((entry) => (entry.err as Error).message)).toEqual([
      "database would not close",
      "queue would not stop",
    ]);
    expect(messages(logger.error)).toEqual(["shutdown step failed", "shutdown step failed"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("treats a step that throws synchronously as a failed step, not as a crash", async () => {
    const logger = recordingLogger();
    const exit = vi.fn<(code: number) => void>();
    const order: string[] = [];
    const shutdown = createGracefulShutdown({
      logger,
      exit,
      phases: [
        [
          {
            name: "throws",
            close: () => {
              throw new Error("synchronous failure");
            },
          },
          quick("other", order),
        ],
      ],
    });

    await shutdown("SIGTERM");

    expect(order).toEqual(["other"]);
    expect(logged(logger.error).map((entry) => entry.step)).toEqual(["throws"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("keeps URLs and other properties of an error out of the failure log line", async () => {
    const logger = recordingLogger();
    const failure = Object.assign(new Error("request to https://rpc.example/v1/secret-api-key failed"), {
      url: "https://rpc.example/v1/secret-api-key",
    });
    const shutdown = createGracefulShutdown({
      logger,
      exit: vi.fn(),
      phases: [[{ name: "rpc", close: () => Promise.reject(failure) }]],
    });

    await shutdown("SIGTERM");

    const { err } = logged(logger.error)[0] as { err: Error };
    expect(err.message).toBe("request to [url] failed");
    expect(err.stack).not.toContain("secret-api-key");
    expect(err).not.toHaveProperty("url");
  });

  it("forces exit 1 at the deadline when a step hangs, and says which step it was waiting for", async () => {
    const logger = recordingLogger();
    const exit = vi.fn<(code: number) => void>();
    const hung = deferred();
    const order: string[] = [];
    const shutdown = createGracefulShutdown({
      logger,
      exit,
      deadlineMs: 5_000,
      phases: [
        [{ name: "hangs", close: () => hung.promise }, quick("fine", order)],
        [quick("never started", order)],
      ],
    });

    const done = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(logged(logger.fatal)).toEqual([
      { reason: "SIGTERM", deadline_ms: 5_000, pending_steps: ["hangs"] },
    ]);
    expect(messages(logger.fatal)).toEqual(["shutdown deadline exceeded; forcing exit"]);

    // The hung step finally closing must neither exit a second time nor let the
    // phase after it start.
    hung.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["fine"]);
  });

  it("does not trip the deadline when the last step finishes just inside it", async () => {
    const logger = recordingLogger();
    const exit = vi.fn<(code: number) => void>();
    const shutdown = createGracefulShutdown({
      logger,
      exit,
      deadlineMs: 5_000,
      phases: [[{ name: "slow", close: () => new Promise<void>((resolve) => setTimeout(resolve, 4_999)) }]],
    });

    const done = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(4_999);
    await done;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(logger.fatal).not.toHaveBeenCalled();
  });

  it("uses a 25 s deadline unless told otherwise", async () => {
    const exit = vi.fn<(code: number) => void>();
    const shutdown = createGracefulShutdown({
      logger: recordingLogger(),
      exit,
      phases: [[{ name: "hangs", close: () => new Promise<void>(() => undefined) }]],
    });

    expect(DEFAULT_SHUTDOWN_DEADLINE_MS).toBe(25_000);
    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(DEFAULT_SHUTDOWN_DEADLINE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("leaves pg-boss less time for running jobs than the whole shutdown gets", () => {
    expect(JOB_DRAIN_TIMEOUT_MS).toBeLessThan(DEFAULT_SHUTDOWN_DEADLINE_MS);
  });

  it("ignores a second request while the first is running: nothing closes twice, nothing exits twice", async () => {
    const logger = recordingLogger();
    const exit = vi.fn<(code: number) => void>();
    const gate = deferred();
    const close = vi.fn(() => gate.promise);
    const shutdown = createGracefulShutdown({ logger, exit, phases: [[{ name: "only", close }]] });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(0);

    expect(close).toHaveBeenCalledTimes(1);
    expect(logged(logger.warn)).toEqual([{ reason: "SIGINT" }]);
    expect(second).toBe(first);

    gate.resolve();
    await Promise.all([first, second]);

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("ignores a request that arrives after the shutdown has finished", async () => {
    const exit = vi.fn<(code: number) => void>();
    const close = vi.fn();
    const shutdown = createGracefulShutdown({ logger: recordingLogger(), exit, phases: [[{ name: "only", close }]] });

    await shutdown("SIGTERM");
    await shutdown("SIGTERM");

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits with the code it was asked for when every step succeeds", async () => {
    const exit = vi.fn<(code: number) => void>();
    const shutdown = createGracefulShutdown({
      logger: recordingLogger(),
      exit,
      phases: [[{ name: "only", close: () => undefined }]],
    });

    await shutdown("uncaughtException", 1);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("raises the exit code to 1 when a fault arrives during a clean shutdown, without closing anything twice", async () => {
    const exit = vi.fn<(code: number) => void>();
    const gate = deferred();
    const close = vi.fn(() => gate.promise);
    const shutdown = createGracefulShutdown({
      logger: recordingLogger(),
      exit,
      phases: [[{ name: "only", close }]],
    });

    const done = shutdown("SIGTERM");
    void shutdown("unhandledRejection", 1);
    gate.resolve();
    await done;

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("still exits, with 1, if the logger itself throws", async () => {
    const logger = recordingLogger();
    logger.info.mockImplementation(() => {
      throw new Error("log stream closed");
    });
    const exit = vi.fn<(code: number) => void>();
    const shutdown = createGracefulShutdown({ logger, exit, phases: [[{ name: "only", close: () => undefined }]] });

    await shutdown("SIGTERM");

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(messages(logger.fatal)).toEqual(["shutdown failed unexpectedly; forcing exit"]);
  });
});

describe("installProcessFaultHandlers", () => {
  it("logs an uncaught exception as fatal and starts a shutdown with exit code 1", () => {
    const logger = recordingLogger();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const target = new EventEmitter();
    installProcessFaultHandlers({ logger, shutdown, target });

    target.emit("uncaughtException", new Error("kaboom"), "uncaughtException");

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(logged(logger.fatal)[0]).toMatchObject({ fault: "uncaughtException" });
    expect(((logged(logger.fatal)[0] as { err: Error }).err).message).toBe("kaboom");
    expect(messages(logger.fatal)).toEqual(["uncaught exception"]);
    expect(shutdown).toHaveBeenCalledExactlyOnceWith("uncaughtException", 1);
  });

  it("logs an unhandled rejection as fatal, including a rejection that is not an Error, and starts a shutdown with exit code 1", () => {
    const logger = recordingLogger();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const target = new EventEmitter();
    installProcessFaultHandlers({ logger, shutdown, target });

    target.emit("unhandledRejection", "plain string reason", Promise.resolve());

    expect(logged(logger.fatal)[0]).toMatchObject({ fault: "unhandledRejection" });
    expect(((logged(logger.fatal)[0] as { err: Error }).err).message).toBe("plain string reason");
    expect(messages(logger.fatal)).toEqual(["unhandled promise rejection"]);
    expect(shutdown).toHaveBeenCalledExactlyOnceWith("unhandledRejection", 1);
  });

  it("does not loop on a second fault during the shutdown: both are logged, nothing runs twice", async () => {
    const logger = recordingLogger();
    const exit = vi.fn<(code: number) => void>();
    const hung = deferred();
    const close = vi.fn(() => hung.promise);
    const shutdown = createGracefulShutdown({
      logger,
      exit,
      deadlineMs: 5_000,
      phases: [[{ name: "only", close }]],
    });
    const target = new EventEmitter();
    installProcessFaultHandlers({ logger, shutdown, target });

    target.emit("unhandledRejection", new Error("first"), Promise.resolve());
    await vi.advanceTimersByTimeAsync(100);
    target.emit("uncaughtException", new Error("second, while shutting down"), "uncaughtException");
    target.emit("uncaughtException", new Error("third"), "uncaughtException");
    await vi.advanceTimersByTimeAsync(100);

    expect(logger.fatal).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("closes in an orderly way and exits 1 after a fault when the steps succeed", async () => {
    const logger = recordingLogger();
    const exit = vi.fn<(code: number) => void>();
    const order: string[] = [];
    const shutdown = createGracefulShutdown({ logger, exit, phases: [[quick("database", order)]] });
    const target = new EventEmitter();
    installProcessFaultHandlers({ logger, shutdown, target });

    target.emit("uncaughtException", new Error("kaboom"), "uncaughtException");
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(["database"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("registers on the real process when no target is given", () => {
    const on = vi.spyOn(process, "on").mockImplementation(() => process);
    try {
      installProcessFaultHandlers({ logger: recordingLogger(), shutdown: vi.fn() });
      expect(on.mock.calls.map((call) => call[0])).toEqual(["uncaughtException", "unhandledRejection"]);
    } finally {
      on.mockRestore();
    }
  });
});

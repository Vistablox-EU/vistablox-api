import type { Logger } from "pino";

import { toSanitizedError } from "../logging/log-redaction.js";

/**
 * How long a process gets to close everything before it is forced to exit.
 *
 * Docker sends SIGKILL once a container's stop_grace_period has elapsed (10 s
 * when unset), which would cut a shutdown short with no log line. The api and
 * worker services in docker-compose.yml and docker-compose.staging.yml set
 * stop_grace_period above this value, so the forced exit below always comes
 * first and says what it was waiting for. Raise both together.
 */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 25_000;

/**
 * How long the worker lets pg-boss wait for jobs that are already running
 * (pg-boss's own default is 30 s). Jobs still running after this are failed
 * back into the queue, so they are retried rather than lost. Kept well below
 * DEFAULT_SHUTDOWN_DEADLINE_MS: the Prisma client the jobs use is only closed
 * afterwards, and the closers that come after need time of their own.
 */
export const JOB_DRAIN_TIMEOUT_MS = 15_000;

type LifecycleLogger = Pick<Logger, "info" | "warn" | "error" | "fatal">;

export interface ShutdownStep {
  /** Appears in the log line for a failure and in the list of steps still pending at the deadline. */
  readonly name: string;
  /** May return a promise; a rejection or a synchronous throw counts as a failed step. */
  readonly close: () => unknown;
}

export interface GracefulShutdownOptions {
  readonly logger: LifecycleLogger;
  /**
   * Phases run one after the other; the steps inside a phase run together.
   * Order matters where one step's users must be done before the step they
   * use is closed: the HTTP server before the database its requests use, the
   * job queue before the database its jobs use.
   */
  readonly phases: ReadonlyArray<ReadonlyArray<ShutdownStep>>;
  /** Defaults to DEFAULT_SHUTDOWN_DEADLINE_MS. */
  readonly deadlineMs?: number;
  /** Defaults to process.exit. Injected by tests. */
  readonly exit?: (code: number) => void;
}

/**
 * Starts the shutdown. `exitCode` is the code the process exits with if every
 * step succeeds: 0 for a signal, 1 for a fault. A failed step or an exceeded
 * deadline makes it 1 whatever was asked.
 */
export type GracefulShutdown = (reason: string, exitCode?: number) => Promise<void>;

/**
 * One orderly way out for a long-running process. It closes everything it was
 * given, logs each step that fails instead of stopping at the first, and exits
 * the process itself: with the right code when the steps are done, or with 1
 * once the deadline passes, whatever is still hanging.
 *
 * It runs once. A second call while the first is in progress (a second SIGTERM,
 * a fault during shutdown) is logged and ignored, except that it can raise the
 * exit code to 1, so a fault during a clean shutdown is not reported as clean.
 */
export function createGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  const { logger, phases } = options;
  const deadlineMs = options.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let running: Promise<void> | undefined;
  let exitCode = 0;

  const run = async (reason: string): Promise<void> => {
    const startedAt = Date.now();
    const pending = new Set<ShutdownStep>();
    let expired = false;
    let failed = false;
    let timer: NodeJS.Timeout | undefined;

    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), deadlineMs);
    });

    const closeStep = async (step: ShutdownStep): Promise<void> => {
      pending.add(step);
      try {
        await step.close();
      } finally {
        pending.delete(step);
      }
    };

    const closeAll = async (): Promise<"closed"> => {
      for (const phase of phases) {
        if (expired) break;
        const results = await Promise.allSettled(phase.map((step) => closeStep(step)));
        results.forEach((result, index) => {
          if (result.status === "rejected") {
            failed = true;
            logger.error(
              { step: phase[index]?.name, err: toSanitizedError(result.reason) },
              "shutdown step failed",
            );
          }
        });
      }
      return "closed";
    };

    try {
      logger.info({ reason, deadline_ms: deadlineMs }, "shutting down");
      const outcome = await Promise.race([closeAll(), deadline]);
      clearTimeout(timer);
      if (outcome === "deadline") {
        expired = true;
        logger.fatal(
          { reason, deadline_ms: deadlineMs, pending_steps: [...pending].map((step) => step.name) },
          "shutdown deadline exceeded; forcing exit",
        );
        exit(1);
        return;
      }
      const code = failed ? Math.max(exitCode, 1) : exitCode;
      logger.info({ reason, exit_code: code, duration_ms: Date.now() - startedAt }, "shutdown complete");
      exit(code);
    } catch (error) {
      clearTimeout(timer);
      // Only reachable if the logger itself throws. Exiting is still the job.
      try {
        logger.fatal({ reason, err: toSanitizedError(error) }, "shutdown failed unexpectedly; forcing exit");
      } finally {
        exit(1);
      }
    }
  };

  return (reason, requestedExitCode = 0) => {
    exitCode = Math.max(exitCode, requestedExitCode);
    if (running !== undefined) {
      logger.warn({ reason }, "shutdown already in progress; ignoring repeated request");
      return running;
    }
    running = run(reason);
    return running;
  };
}

/**
 * Turns an uncaught exception or an unhandled promise rejection into a logged
 * fatal line and an orderly shutdown with exit code 1.
 *
 * Node's default is to print the error and exit at once, which leaves the HTTP
 * server mid-request, pg-boss jobs claimed but never released and the
 * structured log without a line saying why. The process still ends, and with
 * the same code. A second fault during the shutdown is logged and ignored by
 * `shutdown` (see createGracefulShutdown); it does not start another one.
 *
 * `target` is the process; tests pass an EventEmitter.
 */
export function installProcessFaultHandlers(options: {
  readonly logger: Pick<Logger, "fatal">;
  readonly shutdown: GracefulShutdown;
  readonly target?: NodeJS.EventEmitter;
}): void {
  const { logger, shutdown } = options;
  const target = options.target ?? process;

  const onFault = (kind: "uncaughtException" | "unhandledRejection", message: string, error: unknown): void => {
    logger.fatal({ err: toSanitizedError(error), fault: kind }, message);
    void shutdown(kind, 1);
  };

  target.on("uncaughtException", (error: unknown) => {
    onFault("uncaughtException", "uncaught exception", error);
  });
  target.on("unhandledRejection", (reason: unknown) => {
    onFault("unhandledRejection", "unhandled promise rejection", reason);
  });
}

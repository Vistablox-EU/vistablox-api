import type { OperatorKeyLock } from "../../src/infrastructure/blockchain/operator-key-lock.js";

/**
 * An in-process stand-in for the Postgres operator-key lock: one section at a
 * time, in arrival order, and every entry and exit appended to `timeline`
 * ("lock:enter" / "lock:exit") so a test can assert what ran inside it. The
 * real lock is exercised against Postgres in operator-key-lock.integration.test.ts.
 */
export class InProcessOperatorKeyLock implements OperatorKeyLock {
  public held = false;
  public maxConcurrent = 0;
  public sections = 0;
  private active = 0;
  private tail: Promise<unknown> = Promise.resolve();

  public constructor(private readonly timeline: string[] = []) {}

  public run<T>(section: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.active += 1;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
      this.held = true;
      this.sections += 1;
      this.timeline.push("lock:enter");
      try {
        return await section();
      } finally {
        this.timeline.push("lock:exit");
        this.held = false;
        this.active -= 1;
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * An advisory lock key private to the calling test file. Test files run in
 * parallel against one shared database, and the real operator-key lock key
 * (OPERATOR_KEY_ADVISORY_LOCK_KEY) is global to that database: a test that
 * holds it by hand, or counts the sessions waiting for it, would see another
 * file's writers and fail depending on how vitest schedules the two. Pass the
 * result as `PostgresOperatorKeyLock`'s `key` option. Random within a range
 * clear of the production keys (7_311_040_001 and 7_311_040_002), so two files
 * (or two runs against one database) do not share one either.
 */
export function privateOperatorLockKey(): number {
  return 9_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
}

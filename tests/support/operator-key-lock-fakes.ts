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

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  OPERATOR_KEY_ADVISORY_LOCK_KEY,
  OperatorKeyLockTimeoutError,
  PostgresOperatorKeyLock,
} from "../src/infrastructure/blockchain/operator-key-lock.js";
import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { privateOperatorLockKey } from "./support/operator-key-lock-fakes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A writer the way the finalizer and the operator command are: read the
// account's pending nonce, take time (signing, a round trip), then send with
// the nonce it read. The chain accepts a transaction only under the next free
// nonce, as a real node does.
class FakeNodeAccount {
  public nextNonce = 0;
  public accepted: string[] = [];
  public rejected: string[] = [];

  public async writer(name: string, lock: PostgresOperatorKeyLock | undefined): Promise<void> {
    const section = async () => {
      const nonce = this.nextNonce; // read the pending nonce
      await sleep(25); // sign and send
      if (nonce !== this.nextNonce) {
        this.rejected.push(name);
        throw new Error(`nonce too low: ${nonce}`);
      }
      this.nextNonce += 1;
      this.accepted.push(name);
    };
    if (lock === undefined) await section();
    else await lock.run(section);
  }
}

// The advisory lock waiters: sessions asking for the lock with this key that have not been granted it.
// A bigint advisory key is stored as two 32-bit halves, classid (high) and objid (low), objsubid 1.
async function waitersForKey(pool: Pool, key: number): Promise<number> {
  const classid = Math.floor(key / 2 ** 32);
  const objid = key % 2 ** 32;
  const result = await pool.query<{ waiting: number }>(
    `SELECT count(*)::int AS waiting FROM pg_locks
     WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1 AND classid = $1 AND objid = $2`,
    [classid, objid],
  );
  return result.rows[0]!.waiting;
}

async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// Every lock here takes a key of this file's own, never the global
// OPERATOR_KEY_ADVISORY_LOCK_KEY: test files run in parallel against one
// database, and another file that builds a real lock (the mint test does) would
// otherwise queue behind the holders here and be counted among the waiters.
describe.skipIf(databaseUrl === undefined)("operator-key advisory lock against PostgreSQL", () => {
  const database = createPrismaClient(databaseUrl ?? "");
  const pool = new Pool({ connectionString: databaseUrl });
  const key = privateOperatorLockKey();
  const lock = new PostgresOperatorKeyLock(database, { key });
  const waitersForOperatorKey = (client: Pool) => waitersForKey(client, key);

  afterAll(async () => {
    await Promise.all([database.$disconnect(), pool.end()]);
  });

  it("documents its key as a constant distinct from the staff bootstrap's, and takes it unless told otherwise", () => {
    expect(OPERATOR_KEY_ADVISORY_LOCK_KEY).toBe(7_311_040_002);
    expect(OPERATOR_KEY_ADVISORY_LOCK_KEY).not.toBe(7_311_040_001);
    expect(new PostgresOperatorKeyLock(database).key).toBe(OPERATOR_KEY_ADVISORY_LOCK_KEY);
    expect(new PostgresOperatorKeyLock(database, { key: 42 }).key).toBe(42);
    expect(privateOperatorLockKey()).not.toBe(OPERATOR_KEY_ADVISORY_LOCK_KEY);
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 53])("refuses %s as a lock key", (bad) => {
    expect(() => new PostgresOperatorKeyLock(database, { key: bad })).toThrow("positive safe integer");
  });

  it("without the lock two writers that read the same nonce collide: the control that makes the next test mean something", async () => {
    const account = new FakeNodeAccount();

    const results = await Promise.allSettled([account.writer("finalizer", undefined), account.writer("command", undefined)]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(account.rejected).toHaveLength(1);
  });

  it("serialises two concurrent writers: the second reads its nonce only after the first's transaction was accepted", async () => {
    const account = new FakeNodeAccount();

    const results = await Promise.allSettled([account.writer("finalizer", lock), account.writer("command", lock)]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(account.rejected).toEqual([]);
    expect(account.accepted).toHaveLength(2);
    expect(account.nextNonce).toBe(2);
  });

  it("serialises many concurrent writers", async () => {
    const account = new FakeNodeAccount();

    await Promise.all(Array.from({ length: 6 }, (_, index) => account.writer(`writer_${index}`, lock)));

    expect(account.rejected).toEqual([]);
    expect(account.nextNonce).toBe(6);
  });

  it("makes a second section wait until the first has finished, in arrival order", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = lock.run(async () => {
      order.push("first:enter");
      await firstMayFinish;
      order.push("first:exit");
    });
    await until(async () => order.includes("first:enter"), "the first section to start");
    const second = lock.run(async () => {
      order.push("second:enter");
    });
    await until(async () => (await waitersForOperatorKey(pool)) === 1, "the second section to wait for the lock");
    await sleep(100);
    expect(order).toEqual(["first:enter"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:enter", "first:exit", "second:enter"]);
  });

  it("takes the advisory lock key it is configured with, not some other: a session holding that key blocks it", async () => {
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
    let entered = false;
    try {
      const pending = lock.run(async () => {
        entered = true;
      });
      await until(async () => (await waitersForOperatorKey(pool)) === 1, "the section to wait for the held key");
      await sleep(100);
      expect(entered).toBe(false);

      await holder.query("COMMIT");
      await pending;
      expect(entered).toBe(true);
    } finally {
      holder.release();
    }
  });

  it("releases the lock when the section throws, and rethrows its error", async () => {
    await expect(
      lock.run(async () => {
        throw new Error("node rejected the transaction");
      }),
    ).rejects.toThrow("node rejected the transaction");

    let entered = false;
    await lock.run(async () => {
      entered = true;
    });
    expect(entered).toBe(true);
    expect(await waitersForOperatorKey(pool)).toBe(0);
  });

  it("fails a section that cannot get the lock within its wait, with a clear error, without running it", async () => {
    const impatient = new PostgresOperatorKeyLock(database, { key, waitMs: 300 });
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
    let entered = false;
    try {
      const failure = await impatient
        .run(async () => {
          entered = true;
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(OperatorKeyLockTimeoutError);
      expect((failure as Error).message).toContain("could not take the operator-key lock within 300 ms");
      expect(entered).toBe(false);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});

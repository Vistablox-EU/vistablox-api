import { describe, expect, it, vi } from "vitest";

import {
  enqueueTransactionalJob,
  publishTransactionalEvent,
  JOB_RETRY_OPTIONS,
} from "../src/shared/jobs/enqueue-job.js";

describe("enqueueTransactionalJob", () => {
  it("injects trace_id into the payload and applies the retry baseline", async () => {
    const send = vi.fn().mockResolvedValue("job_01");
    const boss = { send } as unknown as Parameters<typeof enqueueTransactionalJob>[0];
    const transaction = {
      $queryRawUnsafe: vi.fn(),
    } as unknown as Parameters<typeof enqueueTransactionalJob>[1];

    await enqueueTransactionalJob(
      boss,
      transaction,
      "case_timers.pre_offering_open_handoff",
      { case_id: "case_01" },
      "trace_01",
    );

    expect(send).toHaveBeenCalledTimes(1);
    const [queueName, data, options] = send.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { db?: { executeSql: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> } },
    ];
    expect(queueName).toBe("case_timers.pre_offering_open_handoff");
    expect(data).toEqual({ case_id: "case_01", trace_id: "trace_01" });
    expect(options).toMatchObject(JOB_RETRY_OPTIONS);
  });

  it("routes the pg-boss db adapter through the caller's own Prisma transaction", async () => {
    const send = vi.fn().mockResolvedValue("job_01");
    const boss = { send } as unknown as Parameters<typeof enqueueTransactionalJob>[0];
    const queryRawUnsafe = vi.fn().mockResolvedValue([{ id: "row_01" }]);
    const transaction = {
      $queryRawUnsafe: queryRawUnsafe,
    } as unknown as Parameters<typeof enqueueTransactionalJob>[1];

    await enqueueTransactionalJob(boss, transaction, "case_timers.pre_offering_open_handoff", {}, "trace_01");

    const options = send.mock.calls[0]?.[2] as {
      db: { executeSql: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };
    };
    const result = await options.db.executeSql("SELECT 1 WHERE id = $1", ["a"]);

    expect(queryRawUnsafe).toHaveBeenCalledWith("SELECT 1 WHERE id = $1", "a");
    expect(result).toEqual({ rows: [{ id: "row_01" }] });
  });
});

describe("publishTransactionalEvent", () => {
  it("injects trace_id into the payload and applies the retry baseline", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const boss = { publish } as unknown as Parameters<typeof publishTransactionalEvent>[0];
    const transaction = {
      $queryRawUnsafe: vi.fn(),
    } as unknown as Parameters<typeof publishTransactionalEvent>[1];

    await publishTransactionalEvent(
      boss,
      transaction,
      "identity.kyc_eligibility_changed",
      { account_id: "acct_01" },
      "trace_01",
    );

    expect(publish).toHaveBeenCalledTimes(1);
    const [event, data, options] = publish.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { db?: { executeSql: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> } },
    ];
    expect(event).toBe("identity.kyc_eligibility_changed");
    expect(data).toEqual({ account_id: "acct_01", trace_id: "trace_01" });
    expect(options).toMatchObject(JOB_RETRY_OPTIONS);
  });

  it("routes the pg-boss db adapter through the caller's own Prisma transaction", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const boss = { publish } as unknown as Parameters<typeof publishTransactionalEvent>[0];
    const queryRawUnsafe = vi.fn().mockResolvedValue([{ id: "row_01" }]);
    const transaction = {
      $queryRawUnsafe: queryRawUnsafe,
    } as unknown as Parameters<typeof publishTransactionalEvent>[1];

    await publishTransactionalEvent(
      boss,
      transaction,
      "identity.kyc_eligibility_changed",
      {},
      "trace_01",
    );

    const options = publish.mock.calls[0]?.[2] as {
      db: { executeSql: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };
    };
    const result = await options.db.executeSql("SELECT 1 WHERE id = $1", ["a"]);

    expect(queryRawUnsafe).toHaveBeenCalledWith("SELECT 1 WHERE id = $1", "a");
    expect(result).toEqual({ rows: [{ id: "row_01" }] });
  });
});

describe.skipIf(process.env.TEST_DATABASE_URL === undefined)(
  "publishTransactionalEvent PostgreSQL integration",
  () => {
    // Proves the one piece of mechanism nothing in this codebase has
    // exercised before this change: a real boss.subscribe() + a
    // transaction-bound boss.publish() actually fans out a durable job row
    // to a subscribed queue, and that row survives (only) once the
    // transaction commits -- independent of whether any of PrismaKycRepository's
    // 9 call sites are wired correctly, which is verified separately.
    const databaseUrl = process.env.TEST_DATABASE_URL;
    const suffix = Date.now();
    const event = `test.publish_event_${suffix}`;
    const queueName = `test.publish_subscriber_${suffix}`;

    it("delivers a transactionally-published event to a subscribed queue", async () => {
      const { PgBoss } = await import("pg-boss");
      const { createPrismaClient } = await import(
        "../src/infrastructure/database/prisma.js"
      );
      const boss = new PgBoss(databaseUrl ?? "");
      const database = createPrismaClient(databaseUrl ?? "");
      try {
        await boss.start();
        await boss.createQueue(queueName);
        await boss.subscribe(event, queueName);

        await database.$transaction(async (transaction) => {
          await publishTransactionalEvent(
            boss,
            transaction,
            event,
            { account_id: "acct_publish_test" },
            "trace_publish_test",
          );
        });

        const jobs = await boss.fetch(queueName);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.data).toEqual({
          account_id: "acct_publish_test",
          trace_id: "trace_publish_test",
        });
      } finally {
        await boss.unsubscribe(event, queueName).catch(() => {});
        await boss.deleteQueue(queueName).catch(() => {});
        await Promise.all([boss.stop(), database.$disconnect()]);
      }
    });
  },
);

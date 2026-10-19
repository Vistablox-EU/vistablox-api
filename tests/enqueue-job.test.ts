import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "../src/infrastructure/database/prisma.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import { enqueueTransactionalJob, JOB_RETRY_OPTIONS } from "../src/shared/jobs/enqueue-job.js";

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

describe("PrismaKycRepository.enqueueDiditWebhookProcessing", () => {
  it("sends the webhook job with the event retry profile, because the Didit outcome is lost if it exhausts its retries", async () => {
    const send = vi.fn().mockResolvedValue("job_01");
    const boss = { send } as unknown as ConstructorParameters<typeof PrismaKycRepository>[1];
    const repository = new PrismaKycRepository({} as DatabaseClient, boss);
    const input = {
      eventId: "evt_01",
      webhookType: "status.updated",
      applicationId: "app_01",
      environment: "sandbox",
      sessionId: "session_01",
      sessionKind: "user",
      workflowId: "workflow_01",
      vendorData: "account_01",
      status: "Approved",
      createdAt: 1_790_000_000,
      traceId: "trace_01",
    };

    await repository.enqueueDiditWebhookProcessing(input);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("provider_events.didit_webhook", input, JOB_RETRY_OPTIONS);
  });
});

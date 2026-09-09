import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("Didit KYC PostgreSQL integration", () => {
  const suffix = randomUUID();
  const accountId = `acct_${suffix}`;
  const sessionStartId = `kyc_start_${suffix}`;
  const diditReference = randomUUID();
  const eventId = randomUUID();
  const eventKey = `didit:webhook:${eventId}`;
  const proofOfAddressSessionStartId = `poa_start_${suffix}`;
  const proofOfAddressDiditReference = randomUUID();
  const betterAuthUserId = `auth_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  // PgBoss's constructor eagerly validates its connection string, so it
  // must not be constructed at describe-body scope (matches every other
  // integration test file's own PrismaOfferingRepository/
  // PrismaOriginationRepository wiring): that body runs even when skipIf
  // skips every test, and databaseUrl is undefined in that case.
  let boss: PgBoss;
  let repository: PrismaKycRepository;
  const startedAt = new Date("2026-09-01T10:00:00.000Z");
  const approvedAt = new Date("2026-09-01T12:00:00.000Z");

  beforeAll(async () => {
    boss = new PgBoss(databaseUrl ?? "");
    repository = new PrismaKycRepository(database, boss);
    await boss.start();
    await boss.createQueue("provider_events.didit_webhook");
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "KYC Test User", `kyc-${suffix}@example.test`, true, "customer"],
    );
    await database.account.create({
      data: {
        id: accountId,
        betterAuthUserId,
      },
    });
  });

  afterAll(async () => {
    await database.auditLog.deleteMany({
      where: {
        OR: [
          { actorAccountId: accountId },
          { resourceId: diditReference },
          { resourceId: proofOfAddressDiditReference },
        ],
      },
    });
    await database.kycEligibilityHistory.deleteMany({ where: { accountId } });
    await database.kycEligibility.deleteMany({ where: { accountId } });
    await database.account.deleteMany({ where: { id: accountId } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
    await Promise.all([boss.stop(), database.$disconnect(), authPool.end()]);
  });

  it("serializes session creation and idempotently applies a provider outcome", async () => {
    expect(
      await repository.reserveSessionStart({
        accountId,
        sessionStartId,
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "HR",
        traceId: `trace_${suffix}`,
        startedAt,
      }),
    ).toBe(true);
    expect(
      await repository.reserveSessionStart({
        accountId,
        sessionStartId: `${sessionStartId}_second`,
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "HR",
        traceId: `trace_${suffix}`,
        startedAt,
      }),
    ).toBe(false);
    expect(
      await repository.completeSessionStart({
        accountId,
        sessionStartId,
        diditReference,
        providerStatus: "Not Started",
        traceId: `trace_${suffix}`,
        completedAt: startedAt,
      }),
    ).toBe(true);

    const applyInput = {
      eventKey,
      eventId,
      diditReference,
      providerStatus: "Approved" as const,
      webhookType: "status.updated",
      traceId: `trace_${suffix}`,
      providerUpdatedAt: approvedAt,
      outcome: {
        eligibilityState: "eligible" as const,
        operationalSubstatus: "kyc_verified_owner_poa_missing" as const,
        reasonCode: "KYC_BASELINE_APPROVED",
        lastVerifiedAt: approvedAt,
        everRequiredManualReview: false,
        renewalDueAt: new Date("2028-09-01T12:00:00.000Z"),
      },
    };
    expect(await repository.applyProviderOutcome(applyInput)).toBe("applied");
    expect(await repository.applyProviderOutcome(applyInput)).toBe("duplicate");

    expect(await repository.getForAccount(accountId)).toMatchObject({
      diditReference,
      eligibilityState: "eligible",
      operationalSubstatus: "kyc_verified_owner_poa_missing",
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "HR",
      lastVerifiedAt: approvedAt,
    });
    expect(
      await database.kycEligibilityHistory.count({ where: { accountId } }),
    ).toBe(2);
    const receipt = await database.auditLog.findUnique({ where: { eventKey } });
    expect(receipt?.changes).toMatchObject({
      matched: true,
      provider_status: "Approved",
      new_state: "eligible",
      reason_code: "KYC_BASELINE_APPROVED",
    });
    expect(JSON.stringify(receipt?.changes)).not.toContain("date_of_birth");

    expect(
      await repository.applyProviderOutcome({
        ...applyInput,
        eventKey: `didit:webhook:${randomUUID()}`,
        eventId: randomUUID(),
        providerStatus: "In Progress",
        providerUpdatedAt: new Date("2026-09-01T11:59:59.000Z"),
        outcome: {
          eligibilityState: "in_progress",
          operationalSubstatus: "kyc_pending",
          reasonCode: "KYC_SESSION_PENDING",
          lastVerifiedAt: null,
          everRequiredManualReview: false,
          renewalDueAt: null,
        },
      }),
    ).toBe("stale");
    expect(await repository.getForAccount(accountId)).toMatchObject({
      eligibilityState: "eligible",
      operationalSubstatus: "kyc_verified_owner_poa_missing",
    });

    expect(
      await repository.reserveProofOfAddressSessionStart({
        accountId,
        sessionStartId: proofOfAddressSessionStartId,
        traceId: `trace_${suffix}`,
        startedAt: new Date("2026-09-01T12:30:00.000Z"),
      }),
    ).toBe(true);
    expect(
      await repository.reserveProofOfAddressSessionStart({
        accountId,
        sessionStartId: `${proofOfAddressSessionStartId}_second`,
        traceId: `trace_${suffix}`,
        startedAt: new Date("2026-09-01T12:30:01.000Z"),
      }),
    ).toBe(false);
    expect(
      await repository.completeProofOfAddressSessionStart({
        accountId,
        sessionStartId: proofOfAddressSessionStartId,
        diditReference: proofOfAddressDiditReference,
        providerStatus: "Not Started",
        traceId: `trace_${suffix}`,
        completedAt: new Date("2026-09-01T12:31:00.000Z"),
      }),
    ).toBe(true);
    const proofOfAddressEventId = randomUUID();
    const proofOfAddressEventKey = `didit:webhook:${proofOfAddressEventId}`;
    const proofOfAddressCurrentUntil = new Date("2026-09-15T00:00:00.000Z");
    const proofOfAddressApplyInput = {
      eventKey: proofOfAddressEventKey,
      eventId: proofOfAddressEventId,
      diditReference: proofOfAddressDiditReference,
      providerStatus: "Approved" as const,
      webhookType: "status.updated",
      traceId: `trace_${suffix}`,
      providerUpdatedAt: new Date("2026-09-01T13:00:00.000Z"),
      outcome: {
        status: "current" as const,
        reasonCode: "OWNER_PROOF_OF_ADDRESS_APPROVED",
        currentUntil: proofOfAddressCurrentUntil,
      },
    };
    expect(
      await repository.applyProofOfAddressOutcome(proofOfAddressApplyInput),
    ).toBe("applied");
    expect(
      await repository.applyProofOfAddressOutcome(proofOfAddressApplyInput),
    ).toBe("duplicate");
    expect(await repository.getForAccount(accountId)).toMatchObject({
      proofOfAddressDiditReference,
      proofOfAddressProviderStatus: "Approved",
      proofOfAddressStatus: "current",
      proofOfAddressCurrentUntil,
      operationalSubstatus: "kyc_verified",
    });
    const proofOfAddressReceipt = await database.auditLog.findUnique({
      where: { eventKey: proofOfAddressEventKey },
    });
    expect(proofOfAddressReceipt?.changes).toMatchObject({
      verification_purpose: "owner_proof_of_address",
      proof_of_address_status: "current",
      reason_code: "OWNER_PROOF_OF_ADDRESS_APPROVED",
    });
    expect(JSON.stringify(proofOfAddressReceipt?.changes)).not.toContain("poa_address");
    expect(JSON.stringify(proofOfAddressReceipt?.changes)).not.toContain("issue_date");
  });

  it("durably enqueues webhook processing with the verified body intact", async () => {
    const enqueueEventId = randomUUID();
    const input = {
      eventId: enqueueEventId,
      webhookType: "status.updated",
      applicationId: "app_01",
      environment: "sandbox",
      sessionId: diditReference,
      sessionKind: "user",
      workflowId: "workflow_01",
      vendorData: accountId,
      status: "Approved",
      createdAt: Math.floor(approvedAt.getTime() / 1_000),
      traceId: `trace_enqueue_${suffix}`,
    };

    await repository.enqueueDiditWebhookProcessing(input);

    // AD-145/AD-062: the enqueued job's own durable row *is* the receipt —
    // assert it directly against pgboss.job, the same technique
    // origination-offering-handoff.integration.test.ts and
    // investor-offering-repository.integration.test.ts already use for
    // their own AD-145 handoffs.
    const enqueued = await authPool.query<{ name: string; data: typeof input }>(
      "SELECT name, data FROM pgboss.job WHERE name = $1 AND data->>'eventId' = $2",
      ["provider_events.didit_webhook", enqueueEventId],
    );
    expect(enqueued.rows).toHaveLength(1);
    expect(enqueued.rows[0]?.data).toEqual(input);
  });

  it("lists a stuck session creation, then a stuck open session, as the same row transitions between them", async () => {
    const stuckSuffix = randomUUID();
    const stuckAccountId = `acct_stuck_${stuckSuffix}`;
    const stuckBetterAuthUserId = `auth_stuck_${stuckSuffix}`;
    const stuckSessionStartId = `kyc_start_stuck_${stuckSuffix}`;
    const stuckDiditReference = randomUUID();

    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [stuckBetterAuthUserId, "Stuck Session Test User", `kyc-stuck-${stuckSuffix}@example.test`, true, "customer"],
    );
    await database.account.create({
      data: { id: stuckAccountId, betterAuthUserId: stuckBetterAuthUserId },
    });

    try {
      expect(
        await repository.reserveSessionStart({
          accountId: stuckAccountId,
          sessionStartId: stuckSessionStartId,
          residenceCountryCode: "DE",
          taxResidenceCountryCode: "DE",
          traceId: `trace_${stuckSuffix}`,
          startedAt,
        }),
      ).toBe(true);

      // Still kyc_session_creating: appears in the creation-stuck list, not
      // the open-stuck list.
      const creating = await repository.listStuckSessionCreationsForTimer();
      expect(creating.find((row) => row.accountId === stuckAccountId)).toMatchObject({
        kind: "baseline",
        sessionStartId: stuckSessionStartId,
      });
      const openWhileCreating = await repository.listStuckOpenSessionsForTimer();
      expect(openWhileCreating.find((row) => row.accountId === stuckAccountId)).toBeUndefined();

      expect(
        await repository.completeSessionStart({
          accountId: stuckAccountId,
          sessionStartId: stuckSessionStartId,
          diditReference: stuckDiditReference,
          providerStatus: "Not Started",
          traceId: `trace_${stuckSuffix}`,
          completedAt: startedAt,
        }),
      ).toBe(true);

      // Now kyc_session_open: appears in the open-stuck list, no longer in
      // the creation-stuck list.
      const open = await repository.listStuckOpenSessionsForTimer();
      expect(open.find((row) => row.accountId === stuckAccountId)).toMatchObject({
        kind: "baseline",
        diditReference: stuckDiditReference,
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "DE",
        everRequiredManualReview: false,
      });
      const creatingWhileOpen = await repository.listStuckSessionCreationsForTimer();
      expect(creatingWhileOpen.find((row) => row.accountId === stuckAccountId)).toBeUndefined();
    } finally {
      await database.kycEligibilityHistory.deleteMany({ where: { accountId: stuckAccountId } });
      await database.kycEligibility.deleteMany({ where: { accountId: stuckAccountId } });
      await database.account.deleteMany({ where: { id: stuckAccountId } });
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [stuckBetterAuthUserId]);
    }
  });

  it("rejects provider statuses outside the reviewed contract", async () => {
    await expect(
      database.kycEligibility.update({
        where: { accountId },
        data: { providerStatus: "Unexpected Status" },
      }),
    ).rejects.toThrow();
    await expect(
      database.kycEligibility.update({
        where: { accountId },
        data: { proofOfAddressProviderStatus: "Unexpected Status" },
      }),
    ).rejects.toThrow();
    await expect(
      database.kycEligibility.update({
        where: { accountId },
        data: {
          proofOfAddressStatus: "current",
          proofOfAddressCurrentUntil: null,
        },
      }),
    ).rejects.toThrow();
  });

  it("publishes identity.kyc_eligibility_changed on an actual write, never on a no-op branch", async () => {
    const publishSuffix = randomUUID();
    const publishAccountId = `acct_publish_${publishSuffix}`;
    const publishBetterAuthUserId = `auth_publish_${publishSuffix}`;
    const publishSessionStartId = `kyc_start_publish_${publishSuffix}`;
    const subscriberQueue = `test.kyc_eligibility_changed_${publishSuffix}`;
    const publishTraceId = `trace_publish_${publishSuffix}`;

    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [publishBetterAuthUserId, "Publish Test User", `kyc-publish-${publishSuffix}@example.test`, true, "customer"],
    );
    await database.account.create({
      data: { id: publishAccountId, betterAuthUserId: publishBetterAuthUserId },
    });
    await boss.createQueue(subscriberQueue);
    await boss.subscribe("identity.kyc_eligibility_changed", subscriberQueue);

    try {
      // reserveSessionStart -- an actual write (create branch) -- must publish.
      expect(
        await repository.reserveSessionStart({
          accountId: publishAccountId,
          sessionStartId: publishSessionStartId,
          residenceCountryCode: "DE",
          taxResidenceCountryCode: "DE",
          traceId: publishTraceId,
          startedAt,
        }),
      ).toBe(true);

      const afterReserve = await boss.fetch(subscriberQueue);
      expect(afterReserve).toHaveLength(1);
      expect(afterReserve[0]?.data).toMatchObject({
        accountId: publishAccountId,
        eligibilityState: "not_started",
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "DE",
        trace_id: publishTraceId,
      });

      // A second reserveSessionStart while already kyc_session_creating is
      // the state-check no-op branch (asserted `false` above, same as the
      // very first test in this file) -- the write never happens, so
      // nothing should publish either.
      expect(
        await repository.reserveSessionStart({
          accountId: publishAccountId,
          sessionStartId: `${publishSessionStartId}_second`,
          residenceCountryCode: "DE",
          taxResidenceCountryCode: "DE",
          traceId: publishTraceId,
          startedAt,
        }),
      ).toBe(false);

      const afterNoOp = await boss.fetch(subscriberQueue);
      expect(afterNoOp).toHaveLength(0);
    } finally {
      await boss.unsubscribe("identity.kyc_eligibility_changed", subscriberQueue).catch(() => {});
      await boss.deleteQueue(subscriberQueue).catch(() => {});
      await database.kycEligibility.deleteMany({ where: { accountId: publishAccountId } });
      await database.account.deleteMany({ where: { id: publishAccountId } });
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [publishBetterAuthUserId]);
    }
  });
});

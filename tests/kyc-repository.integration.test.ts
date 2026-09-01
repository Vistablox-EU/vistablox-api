import { randomUUID } from "node:crypto";

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
  const repository = new PrismaKycRepository(database);
  const startedAt = new Date("2026-09-01T10:00:00.000Z");
  const approvedAt = new Date("2026-09-01T12:00:00.000Z");

  beforeAll(async () => {
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
    await Promise.all([database.$disconnect(), authPool.end()]);
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
});

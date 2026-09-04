import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaSettlementRepository } from "../src/modules/settlement/repository/prisma-settlement.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("PrismaSettlementRepository PostgreSQL integration", () => {
  const suffix = randomUUID();
  const accountId = `account_settlement_${suffix}`;
  const betterAuthUserId = `auth_settlement_${suffix}`;
  const propertyId = `property_settlement_${suffix}`;

  // Three cases: one past-deadline with a token id (the real candidate),
  // one past-deadline but never tokenized, one future-deadline -- proves
  // findPivsWithPassedIpoDeadline filters on both conditions, not just one.
  const pastCaseId = `case_settlement_past_${suffix}`;
  const untokenizedCaseId = `case_settlement_untokenized_${suffix}`;
  const futureCaseId = `case_settlement_future_${suffix}`;
  const pastPropertyId = `property_settlement_past_${suffix}`;
  const untokenizedPropertyId = `property_settlement_untokenized_${suffix}`;
  const futurePropertyId = `property_settlement_future_${suffix}`;
  const pastPivId = `piv_settlement_past_${suffix}`;
  const untokenizedPivId = `piv_settlement_untokenized_${suffix}`;
  const futurePivId = `piv_settlement_future_${suffix}`;

  const walletAddress = `0xAbC${suffix.replace(/-/g, "").slice(0, 37)}`;

  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const repository = new PrismaSettlementRepository(database);

  beforeAll(async () => {
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Settlement Test Investor", `settlement-${suffix}@example.test`, true, "customer"],
    );
    await database.account.create({ data: { id: accountId, betterAuthUserId } });
    await database.walletRegistration.create({
      data: {
        accountId,
        walletAddress,
        registrationCommitment: `commitment_${suffix}`,
        registeredAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });

    for (const [propId, caseId, pivId, ipoEndAt, tokenId] of [
      [pastPropertyId, pastCaseId, pastPivId, new Date("2026-01-01T00:00:00.000Z"), "1"],
      [untokenizedPropertyId, untokenizedCaseId, untokenizedPivId, new Date("2026-01-01T00:00:00.000Z"), null],
      [futurePropertyId, futureCaseId, futurePivId, new Date("2099-01-01T00:00:00.000Z"), "2"],
    ] as const) {
      await database.property.create({
        data: {
          id: propId,
          countryCode: "RS",
          city: "Belgrade",
          addressLine: `Settlement Test ${propId}`,
          ownerDeclaredValueEur: "100000.00",
        },
      });
      await database.originationCase.create({
        data: {
          id: caseId,
          propertyId: propId,
          applicantAccountId: accountId,
          stage: "pre_offering_open",
          legalExecutionEventRefs: [],
          legalDocumentRefs: [],
          appraisalDocumentRefs: [],
          ipoEndAt,
        },
      });
      await database.piv.create({
        data: {
          id: pivId,
          propertyId: propId,
          caseId,
          ...(tokenId === null ? {} : { tokenId }),
        },
      });
    }
  });

  afterAll(async () => {
    await database.chainSettlementEvent.deleteMany({
      where: { position: { pivId: { in: [pastPivId, untokenizedPivId, futurePivId] } } },
    });
    await database.positionLedger.deleteMany({
      where: { pivId: { in: [pastPivId, untokenizedPivId, futurePivId] } },
    });
    await database.piv.deleteMany({ where: { id: { in: [pastPivId, untokenizedPivId, futurePivId] } } });
    await database.originationCase.deleteMany({
      where: { id: { in: [pastCaseId, untokenizedCaseId, futureCaseId] } },
    });
    await database.property.deleteMany({
      where: { id: { in: [pastPropertyId, untokenizedPropertyId, futurePropertyId] } },
    });
    await database.walletRegistration.deleteMany({ where: { accountId } });
    await database.account.deleteMany({ where: { id: accountId } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  it("finds only PIVs with a token id whose case's ipo_end_at has passed", async () => {
    const candidates = await repository.findPivsWithPassedIpoDeadline(new Date("2026-09-01T00:00:00.000Z"));
    const candidateIds = candidates.map((c) => c.pivId);

    expect(candidateIds).toContain(pastPivId);
    expect(candidateIds).not.toContain(untokenizedPivId);
    expect(candidateIds).not.toContain(futurePivId);

    const past = candidates.find((c) => c.pivId === pastPivId);
    expect(past?.tokenId).toBe("1");
  });

  it("resolves a wallet to its account case-insensitively", async () => {
    expect(await repository.resolveAccountIdForWallet(walletAddress)).toBe(accountId);
    expect(await repository.resolveAccountIdForWallet(walletAddress.toLowerCase())).toBe(accountId);
    expect(await repository.resolveAccountIdForWallet(walletAddress.toUpperCase())).toBe(accountId);
    expect(await repository.resolveAccountIdForWallet("0x000000000000000000000000000000000000dead")).toBeNull();
  });

  it("reports hasPosition correctly before and after recordEscrowMintedPosition, without a reservation", async () => {
    expect(await repository.hasPosition(pastPivId, accountId)).toBe(false);

    const { positionId } = await repository.recordEscrowMintedPosition({
      pivId: pastPivId,
      accountId,
      walletAddress,
      unitCount: "50000.000000",
      costBasisEur: "50000.000000",
      activatedAt: new Date("2026-09-01T12:00:00.000Z"),
      tokenContractAddress: "0x1111111111111111111111111111111111111",
      tokenId: "1",
      chainTxHash: "0xdeadbeef",
    });

    expect(await repository.hasPosition(pastPivId, accountId)).toBe(true);

    const position = await database.positionLedger.findUniqueOrThrow({ where: { id: positionId } });
    expect(position.reservationId).toBeNull();
    expect(position.positionStatus).toBe("active");
    expect(position.holderWalletAddress).toBe(walletAddress);

    const events = await database.chainSettlementEvent.findMany({ where: { positionId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "mint", chainTxHash: "0xdeadbeef" });
  });
});

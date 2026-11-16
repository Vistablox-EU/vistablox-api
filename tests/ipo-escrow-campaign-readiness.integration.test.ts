import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaSettlementRepository } from "../src/modules/settlement/repository/prisma-settlement.repository.js";
import { deleteSettlementEscrowReadiness } from "./support/settlement-escrow-db.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// The escrow activation sweep's queries (#176): which offerings still need
// their IPO escrow campaign opened, and the readiness record it writes.
describe.skipIf(databaseUrl === undefined)("IPO escrow campaign readiness PostgreSQL integration", () => {
  const suffix = randomUUID();
  const now = new Date("2026-10-01T12:00:00.000Z");
  const future = new Date("2026-11-01T12:00:00.000Z");
  const past = new Date("2026-09-01T12:00:00.000Z");
  // Outside the range intake.piv_token_id_seq hands out, as in the other
  // settlement suites.
  const tokenBase = BigInt(`0x${suffix.replace(/-/g, "").slice(0, 12)}`) * 100n + 7_000_000_000_000_000n;

  const fixtures = {
    awaiting: { ipoEndAt: future, status: "pre_offering", tokenized: true, published: false },
    pastDeadline: { ipoEndAt: past, status: "pre_offering", tokenized: true, published: false },
    untokenized: { ipoEndAt: future, status: "pre_offering", tokenized: false, published: false },
    closed: { ipoEndAt: future, status: "closed", tokenized: true, published: false },
    finalTermsPublished: { ipoEndAt: future, status: "pre_offering", tokenized: true, published: true },
  } as const;
  type Name = keyof typeof fixtures;
  const names = Object.keys(fixtures) as Name[];
  const pivId = (name: Name) => `piv_escrow_ready_${name}_${suffix}`;
  const tokenId = (name: Name) => (tokenBase + BigInt(names.indexOf(name))).toString();
  const accountId = `account_escrow_ready_${suffix}`;
  const betterAuthUserId = `auth_escrow_ready_${suffix}`;

  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const repository = new PrismaSettlementRepository(database);

  beforeAll(async () => {
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Escrow Readiness Applicant", `escrow-ready-${suffix}@example.test`, true, "customer"],
    );
    await database.account.create({ data: { id: accountId, betterAuthUserId } });
    for (const name of names) {
      const fixture = fixtures[name];
      const propertyId = `property_escrow_ready_${name}_${suffix}`;
      const caseId = `case_escrow_ready_${name}_${suffix}`;
      await database.property.create({
        data: {
          id: propertyId,
          countryCode: "RS",
          city: "Belgrade",
          addressLine: `Escrow Readiness ${name} ${suffix}`,
          ownerDeclaredValueEur: "100000.00",
        },
      });
      await database.intakeCase.create({
        data: {
          id: caseId,
          propertyId,
          applicantAccountId: accountId,
          stage: "pre_offering_open",
          legalExecutionEventRefs: [],
          legalDocumentRefs: [],
          appraisalDocumentRefs: [],
          ipoEndAt: fixture.ipoEndAt,
        },
      });
      await database.piv.create({
        data: { id: pivId(name), propertyId, caseId, ...(fixture.tokenized ? { tokenId: tokenId(name) } : {}) },
      });
      await database.offering.create({
        data: {
          id: `offering_escrow_ready_${name}_${suffix}`,
          pivId: pivId(name),
          minimumRaiseEur: "250000.50",
          targetRaiseEur: "250000.50",
          status: fixture.status,
          ...(fixture.published ? { finalOfferingPublishedAt: past } : {}),
        },
      });
    }
  });

  afterAll(async () => {
    const pivIds = names.map(pivId);
    await deleteSettlementEscrowReadiness(database, pivIds);
    await database.offering.deleteMany({ where: { pivId: { in: pivIds } } });
    await database.piv.deleteMany({ where: { id: { in: pivIds } } });
    await database.intakeCase.deleteMany({ where: { applicantAccountId: accountId } });
    await database.property.deleteMany({ where: { id: { in: names.map((name) => `property_escrow_ready_${name}_${suffix}`) } } });
    await database.account.deleteMany({ where: { id: accountId } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  const ours = async () =>
    (await repository.findOfferingsAwaitingIpoEscrowCampaign(now)).filter((row) => row.pivId.endsWith(suffix));

  it("finds only tokenized offerings still open for reservations, before their IPO deadline, with no campaign recorded", async () => {
    expect(await ours()).toEqual([
      { pivId: pivId("awaiting"), tokenId: tokenId("awaiting"), targetRaiseEur: "250000.50", ipoEndAt: future },
    ]);
  });

  it("records the campaign once, keeps the first record on a replay, and then stops listing the offering", async () => {
    const input = {
      pivId: pivId("awaiting"),
      tokenId: tokenId("awaiting"),
      escrowContractAddress: "0x00000000000000000000000000000000000E5c20",
      targetAmount: 250_000_500_000n,
      deadlineAt: future,
      treasuryAddress: "0x000000000000000000000000000000000000Ba5e",
      openTxHash: `0x${"AB".repeat(32)}`,
    };
    await repository.recordIpoEscrowCampaignOpened(input);
    await repository.recordIpoEscrowCampaignOpened({ ...input, openTxHash: null });

    const row = await database.ipoEscrowCampaign.findUniqueOrThrow({ where: { pivId: pivId("awaiting") } });
    expect(row).toMatchObject({
      escrowContractAddress: "0x00000000000000000000000000000000000e5c20",
      treasuryAddress: "0x000000000000000000000000000000000000ba5e",
      openTxHash: `0x${"ab".repeat(32)}`,
      deadlineAt: future,
    });
    expect(row.tokenId.toString()).toBe(tokenId("awaiting"));
    expect(row.targetAmount.toString()).toBe("250000500000");
    expect(await ours()).toEqual([]);
  });
});

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaSettlementRepository } from "../src/modules/settlement/repository/prisma-settlement.repository.js";
import type { RecordIpoEscrowCampaignObservationInput } from "../src/modules/settlement/repository/settlement.repository.js";
import { CONFIGURED_ESCROW_CONTRACT, REDEPLOYED_ESCROW_CONTRACT } from "./support/settlement-escrow-contracts.js";
import { deleteSettlementEscrowReadiness } from "./support/settlement-escrow-db.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// The operator command's queries (#176, AD-286): which offerings it considers,
// and the observation of their IPO escrow campaign it writes, refreshes and reads.
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
    (await repository.findOfferingsForIpoEscrowActivation(now)).filter((row) => row.pivId.endsWith(suffix));

  const observation = (name: Name, overrides: Partial<RecordIpoEscrowCampaignObservationInput> = {}) => ({
    pivId: pivId(name),
    tokenId: tokenId(name),
    escrowContractAddress: "0x00000000000000000000000000000000000E5c20",
    targetAmount: 250_000_500_000n,
    deadlineAt: future,
    treasuryAddress: "0x000000000000000000000000000000000000Ba5e",
    openTxHash: `0x${"AB".repeat(32)}`,
    state: "open" as const,
    observedAt: new Date("2026-10-01T12:00:00.000Z"),
    ...overrides,
  });

  it("lists only tokenized offerings still open for reservations with an IPO deadline ahead, whether or not a campaign is recorded", async () => {
    expect(await ours()).toEqual([
      { pivId: pivId("awaiting"), tokenId: tokenId("awaiting"), targetRaiseEur: "250000.50", ipoEndAt: future },
    ]);
  });

  it("records the observation, canonicalises addresses and the hash, and finds it again", async () => {
    await repository.recordIpoEscrowCampaignObservation(observation("awaiting"));

    expect(await repository.findIpoEscrowCampaign(pivId("awaiting"))).toEqual({
      pivId: pivId("awaiting"),
      tokenId: tokenId("awaiting"),
      escrowContractAddress: "0x00000000000000000000000000000000000e5c20",
      targetAmount: 250_000_500_000n,
      deadlineAt: future,
      treasuryAddress: "0x000000000000000000000000000000000000ba5e",
      openTxHash: `0x${"ab".repeat(32)}`,
      observedState: "open",
      observedAt: new Date("2026-10-01T12:00:00.000Z"),
    });
    expect(await repository.findIpoEscrowCampaign(pivId("closed"))).toBeNull();
    // Still listed: the command re-reads the campaign of an offering that has a row.
    expect((await ours()).map((row) => row.pivId)).toEqual([pivId("awaiting")]);
  });

  it("replaces the stored observation with a newer one but keeps the open tx hash a re-read does not know, and ignores an older one", async () => {
    const t1 = new Date("2026-10-01T12:00:00.000Z");
    const t2 = new Date("2026-10-01T13:00:00.000Z");
    const t0 = new Date("2026-10-01T11:00:00.000Z");
    await repository.recordIpoEscrowCampaignObservation(observation("awaiting", { observedAt: t1 }));

    await repository.recordIpoEscrowCampaignObservation(
      observation("awaiting", { observedAt: t2, openTxHash: null, deadlineAt: past }),
    );
    expect(await repository.findIpoEscrowCampaign(pivId("awaiting"))).toMatchObject({
      observedAt: t2,
      deadlineAt: past,
      openTxHash: `0x${"ab".repeat(32)}`,
    });

    await repository.recordIpoEscrowCampaignObservation(
      observation("awaiting", { observedAt: t0, state: "failed", deadlineAt: future }),
    );
    expect(await repository.findIpoEscrowCampaign(pivId("awaiting"))).toMatchObject({
      observedState: "open",
      observedAt: t2,
      deadlineAt: past,
    });
    // Put it back for the tests below.
    await repository.recordIpoEscrowCampaignObservation(observation("awaiting", { observedAt: new Date("2026-10-01T14:00:00.000Z") }));
  });

  it("refreshes only an existing row, only to a different state, and never to an older observation", async () => {
    const t = new Date("2026-10-02T12:00:00.000Z");

    expect(
      await repository.refreshIpoEscrowCampaignState({
        pivId: pivId("untokenized"),
        escrowContractAddress: CONFIGURED_ESCROW_CONTRACT,
        state: "failed",
        observedAt: t,
      }),
    ).toBe(false);
    expect(await repository.findIpoEscrowCampaign(pivId("untokenized"))).toBeNull();

    expect(
      await repository.refreshIpoEscrowCampaignState({
        pivId: pivId("awaiting"),
        escrowContractAddress: CONFIGURED_ESCROW_CONTRACT,
        state: "open",
        observedAt: t,
      }),
    ).toBe(false);
    expect(
      await repository.refreshIpoEscrowCampaignState({
        pivId: pivId("awaiting"),
        escrowContractAddress: CONFIGURED_ESCROW_CONTRACT,
        state: "failed",
        observedAt: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ).toBe(false);
    expect(await repository.findIpoEscrowCampaign(pivId("awaiting"))).toMatchObject({ observedState: "open" });

    // A state read on another escrow contract (the configured one after a redeploy) does not move a row that
    // describes the contract before it, however new the observation and however different the state.
    expect(
      await repository.refreshIpoEscrowCampaignState({
        pivId: pivId("awaiting"),
        escrowContractAddress: REDEPLOYED_ESCROW_CONTRACT,
        state: "successful",
        observedAt: t,
      }),
    ).toBe(false);
    expect(await repository.findIpoEscrowCampaign(pivId("awaiting"))).toMatchObject({
      observedState: "open",
      escrowContractAddress: CONFIGURED_ESCROW_CONTRACT.toLowerCase(),
    });

    // The stored address is the canonical lower-case form; the contract it was read from may be checksummed.
    expect(
      await repository.refreshIpoEscrowCampaignState({
        pivId: pivId("awaiting"),
        escrowContractAddress: CONFIGURED_ESCROW_CONTRACT,
        state: "successful",
        observedAt: t,
      }),
    ).toBe(true);
    expect(await repository.findIpoEscrowCampaign(pivId("awaiting"))).toMatchObject({
      observedState: "successful",
      observedAt: t,
      deadlineAt: future,
    });
  });

  it("rejects a state the check constraint does not allow", async () => {
    await expect(
      repository.recordIpoEscrowCampaignObservation(observation("pastDeadline", { state: "paused" as never })),
    ).rejects.toThrow();
  });
});

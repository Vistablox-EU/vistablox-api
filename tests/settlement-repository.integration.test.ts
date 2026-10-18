import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaSettlementRepository } from "../src/modules/settlement/repository/prisma-settlement.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("PrismaSettlementRepository PostgreSQL integration", () => {
  const suffix = randomUUID();
  // Outside the range intake.piv_token_id_seq hands out (it starts at 1, and
  // other test files take ids from it while this one runs), so these fixed
  // Pivs cannot collide with sequence-assigned ones on the unique token_id.
  const pastTokenId = String(8_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
  const futureTokenId = String(BigInt(pastTokenId) + 1n);
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

  // One PIV per escrow-mint test below, so each starts with no intent and no
  // position for (piv, account). Their token ids are derived from the suffix
  // so they cannot collide with the fixed ones above or with another suite's.
  const mintTestNames = [
    "create",
    "constraints",
    "sent",
    "record",
    "restart",
    "atomic",
    "rollback",
    "checks",
    "fkeys",
  ] as const;
  type MintTestName = (typeof mintTestNames)[number];
  const mintPivIds = Object.fromEntries(
    mintTestNames.map((name) => [name, `piv_settlement_mint_${name}_${suffix}`]),
  ) as Record<MintTestName, string>;
  const mintPropertyIds = mintTestNames.map((name) => `property_settlement_mint_${name}_${suffix}`);
  const mintCaseIds = mintTestNames.map((name) => `case_settlement_mint_${name}_${suffix}`);
  const mintTokenBase = BigInt(`0x${suffix.replace(/-/g, "").slice(0, 12)}`) * 100n;
  const mintTokenId = (name: MintTestName) => (mintTokenBase + BigInt(mintTestNames.indexOf(name))).toString();
  const tokenContractAddress = "0x1111111111111111111111111111111111111";

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
      [pastPropertyId, pastCaseId, pastPivId, new Date("2026-01-01T00:00:00.000Z"), pastTokenId],
      [untokenizedPropertyId, untokenizedCaseId, untokenizedPivId, new Date("2026-01-01T00:00:00.000Z"), null],
      [futurePropertyId, futureCaseId, futurePivId, new Date("2099-01-01T00:00:00.000Z"), futureTokenId],
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
      await database.intakeCase.create({
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

    for (const [index, name] of mintTestNames.entries()) {
      await database.property.create({
        data: {
          id: mintPropertyIds[index]!,
          countryCode: "RS",
          city: "Belgrade",
          addressLine: `Settlement Mint Test ${name} ${suffix}`,
          ownerDeclaredValueEur: "100000.00",
        },
      });
      await database.intakeCase.create({
        data: {
          id: mintCaseIds[index]!,
          propertyId: mintPropertyIds[index]!,
          applicantAccountId: accountId,
          stage: "pre_offering_open",
          legalExecutionEventRefs: [],
          legalDocumentRefs: [],
          appraisalDocumentRefs: [],
          ipoEndAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      });
      await database.piv.create({
        data: {
          id: mintPivIds[name],
          propertyId: mintPropertyIds[index]!,
          caseId: mintCaseIds[index]!,
          tokenId: mintTokenId(name),
        },
      });
    }
  });

  afterAll(async () => {
    const allPivIds = [pastPivId, untokenizedPivId, futurePivId, ...Object.values(mintPivIds)];
    await database.chainSettlementEvent.deleteMany({ where: { position: { pivId: { in: allPivIds } } } });
    await database.positionLedger.deleteMany({ where: { pivId: { in: allPivIds } } });
    await database.escrowMintIntent.deleteMany({ where: { pivId: { in: allPivIds } } });
    await database.piv.deleteMany({ where: { id: { in: allPivIds } } });
    await database.intakeCase.deleteMany({
      where: { id: { in: [pastCaseId, untokenizedCaseId, futureCaseId, ...mintCaseIds] } },
    });
    await database.property.deleteMany({
      where: { id: { in: [pastPropertyId, untokenizedPropertyId, futurePropertyId, ...mintPropertyIds] } },
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
    expect(past?.tokenId).toBe(pastTokenId);
  });

  it("resolves a wallet to its account case-insensitively", async () => {
    expect(await repository.resolveAccountIdForWallet(walletAddress)).toBe(accountId);
    expect(await repository.resolveAccountIdForWallet(walletAddress.toLowerCase())).toBe(accountId);
    expect(await repository.resolveAccountIdForWallet(walletAddress.toUpperCase())).toBe(accountId);
    expect(await repository.resolveAccountIdForWallet("0x000000000000000000000000000000000000dead")).toBeNull();
  });

  it("reports hasPosition correctly before and after recordEscrowMintedPosition, without a reservation", async () => {
    expect(await repository.hasPosition(pastPivId, accountId)).toBe(false);

    const { intent } = await repository.createEscrowMintIntent({
      pivId: pastPivId,
      accountId,
      walletAddress,
      tokenContractAddress: "0x1111111111111111111111111111111111111",
      tokenId: "1",
      mintAmount: 50_000_000_000n,
      attemptedAt: new Date("2026-09-01T11:59:00.000Z"),
      searchFromBlock: null,
    });
    await repository.recordEscrowMintSent({ intentId: intent.id, attempt: 1, txHash: "0xdeadbeef" });
    const { positionId } = await repository.recordEscrowMintedPosition({
      escrowMintIntentId: intent.id,
      pivId: pastPivId,
      accountId,
      walletAddress,
      unitCount: "50000.000000",
      costBasisEur: "50000.000000",
      activatedAt: new Date("2026-09-01T12:00:00.000Z"),
      tokenContractAddress: "0x1111111111111111111111111111111111111",
      tokenId: pastTokenId,
      chainTxHash: "0xdeadbeef",
    });

    expect(await repository.hasPosition(pastPivId, accountId)).toBe(true);

    const position = await database.positionLedger.findUniqueOrThrow({ where: { id: positionId } });
    expect(position.reservationId).toBeNull();
    expect(position.positionStatus).toBe("active");
    expect(position.holderWalletAddress).toBe(walletAddress);
    expect(position.escrowMintIntentId).toBe(intent.id);

    const events = await database.chainSettlementEvent.findMany({ where: { positionId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "mint",
      chainTxHash: "0xdeadbeef",
      tokenContractAddress: "0x1111111111111111111111111111111111111",
    });
    expect(events[0]?.tokenId.toFixed(0)).toBe("1");
  });

  describe("escrow mint intents", () => {
    const attemptedAt = new Date("2026-10-18T12:00:00.000Z");
    const activatedAt = new Date("2026-10-18T12:05:00.000Z");
    const mintAmount = 50_000_000_000n;

    const newIntent = (name: MintTestName) =>
      repository.createEscrowMintIntent({
        pivId: mintPivIds[name],
        accountId,
        walletAddress,
        tokenContractAddress,
        tokenId: mintTokenId(name),
        mintAmount,
        attemptedAt,
        searchFromBlock: 1234n,
      });

    const recordInput = (name: MintTestName, escrowMintIntentId: string, chainTxHash: string) => ({
      escrowMintIntentId,
      pivId: mintPivIds[name],
      accountId,
      walletAddress,
      unitCount: "50000.000000",
      costBasisEur: "50000.000000",
      activatedAt,
      tokenContractAddress,
      tokenId: mintTokenId(name),
      chainTxHash,
    });

    it("keeps exactly one intent per (piv, account) even when several runs race to write it", async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => newIntent("create")));

      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.intent.id)).size).toBe(1);
      expect(await database.escrowMintIntent.count({ where: { pivId: mintPivIds.create, accountId } })).toBe(1);

      expect(await repository.findEscrowMintIntent(mintPivIds.create, accountId)).toEqual({
        id: results[0]!.intent.id,
        pivId: mintPivIds.create,
        accountId,
        walletAddress,
        tokenContractAddress,
        tokenId: mintTokenId("create"),
        mintAmount,
        status: "sending",
        mintTxHash: null,
        attempt: 1,
        attemptedAt,
        searchFromBlock: 1234n,
      });
      expect(await repository.findEscrowMintIntent(mintPivIds.create, `account_nobody_${suffix}`)).toBeNull();
    });

    it("refuses, in the database itself, a second intent or a second position for the same mint", async () => {
      const { intent } = await newIntent("constraints");

      // Bypassing the repository entirely: the unique indexes are what hold.
      await expect(
        database.escrowMintIntent.create({
          data: {
            id: `escrow_mint_dup_${suffix}`,
            pivId: mintPivIds.constraints,
            accountId,
            holderWalletAddress: walletAddress,
            tokenContractAddress,
            tokenId: mintTokenId("constraints"),
            mintAmount: "1",
            attemptedAt,
          },
        }),
      ).rejects.toThrow(/unique constraint/i);

      await repository.recordEscrowMintSent({ intentId: intent.id, attempt: 1, txHash: "0xconstraints" });
      await repository.recordEscrowMintedPosition(recordInput("constraints", intent.id, "0xconstraints"));
      await expect(
        database.positionLedger.create({
          data: {
            id: `position_dup_${suffix}`,
            escrowMintIntentId: intent.id,
            pivId: mintPivIds.constraints,
            accountId,
            unitCount: "50000.000000",
            costBasisEur: "50000.000000",
          },
        }),
      ).rejects.toThrow(/unique constraint/i);

      expect(await database.positionLedger.count({ where: { escrowMintIntentId: intent.id } })).toBe(1);
    });

    it("leaves positions without an intent unconstrained, as the reservation flow and older escrow rows are", async () => {
      for (const id of ["a", "b"]) {
        await database.positionLedger.create({
          data: {
            id: `position_no_intent_${id}_${suffix}`,
            pivId: mintPivIds.checks,
            accountId,
            unitCount: "1.000000",
            costBasisEur: "1.00",
          },
        });
      }

      expect(await database.positionLedger.count({ where: { pivId: mintPivIds.checks, accountId } })).toBe(2);
    });

    it("enforces the intent's own invariants with CHECK constraints, each by its own constraint", async () => {
      const base = {
        pivId: mintPivIds.checks,
        accountId,
        holderWalletAddress: walletAddress,
        tokenContractAddress,
        tokenId: mintTokenId("checks"),
        mintAmount: "1",
        attemptedAt,
      };
      // Each row violates exactly one constraint, so the name asserted is the only one that can fire.
      const attempts: Array<[string, Record<string, unknown>, string]> = [
        ["an unknown status", { status: "bogus", mintTxHash: "0xchk" }, "escrow_mint_intents_status_check"],
        ["a mint_sent intent with no hash", { status: "mint_sent" }, "escrow_mint_intents_hash_check"],
        [
          "a recorded intent with no hash",
          { status: "recorded", recordedAt: attemptedAt },
          "escrow_mint_intents_hash_check",
        ],
        [
          "a recorded intent with no recorded_at",
          { status: "recorded", mintTxHash: "0xchk" },
          "escrow_mint_intents_recorded_check",
        ],
        ["a sending intent with a recorded_at", { recordedAt: attemptedAt }, "escrow_mint_intents_recorded_check"],
        ["a zero mint amount", { mintAmount: "0" }, "escrow_mint_intents_mint_amount_check"],
        ["a zero attempt number", { attempt: 0 }, "escrow_mint_intents_attempt_check"],
      ];

      for (const [index, [label, overrides, constraint]] of attempts.entries()) {
        await expect(
          database.escrowMintIntent.create({
            data: { id: `escrow_mint_chk_${index}_${suffix}`, ...base, ...overrides } as never,
          }),
          label,
        ).rejects.toThrow(constraint);
      }
      expect(await database.escrowMintIntent.count({ where: { pivId: mintPivIds.checks } })).toBe(0);
    });

    it("refuses an intent for a PIV or account that does not exist, and a position for an intent that does not exist", async () => {
      const base = {
        holderWalletAddress: walletAddress,
        tokenContractAddress,
        tokenId: mintTokenId("fkeys"),
        mintAmount: "1",
        attemptedAt,
      };

      await expect(
        database.escrowMintIntent.create({
          data: { id: `escrow_mint_fk_piv_${suffix}`, pivId: `piv_missing_${suffix}`, accountId, ...base },
        }),
      ).rejects.toThrow("escrow_mint_intents_piv_id_fkey");
      await expect(
        database.escrowMintIntent.create({
          data: { id: `escrow_mint_fk_acct_${suffix}`, pivId: mintPivIds.fkeys, accountId: `account_missing_${suffix}`, ...base },
        }),
      ).rejects.toThrow("escrow_mint_intents_account_id_fkey");
      await expect(
        database.positionLedger.create({
          data: {
            id: `position_fk_${suffix}`,
            escrowMintIntentId: `escrow_mint_missing_${suffix}`,
            pivId: mintPivIds.fkeys,
            accountId,
            unitCount: "1.000000",
            costBasisEur: "1.00",
          },
        }),
      ).rejects.toThrow("position_ledger_escrow_mint_intent_id_fkey");

      expect(await database.escrowMintIntent.count({ where: { pivId: mintPivIds.fkeys } })).toBe(0);
      expect(await database.positionLedger.count({ where: { pivId: mintPivIds.fkeys } })).toBe(0);
    });

    it("records the hash only on the attempt that sent it, idempotently", async () => {
      const { intent } = await newIntent("sent");

      await repository.recordEscrowMintSent({ intentId: intent.id, attempt: 1, txHash: "0xsent" });
      expect(await repository.findEscrowMintIntent(mintPivIds.sent, accountId)).toMatchObject({
        status: "mint_sent",
        mintTxHash: "0xsent",
      });

      await repository.recordEscrowMintSent({ intentId: intent.id, attempt: 1, txHash: "0xsent" }); // replay
      await expect(
        repository.recordEscrowMintSent({ intentId: intent.id, attempt: 1, txHash: "0xother" }),
      ).rejects.toThrow(/cannot record mint tx 0xother/);
      await expect(
        repository.recordEscrowMintSent({ intentId: intent.id, attempt: 2, txHash: "0xsent" }),
      ).rejects.toThrow(/cannot record mint tx 0xsent/);

      expect(await repository.findEscrowMintIntent(mintPivIds.sent, accountId)).toMatchObject({
        status: "mint_sent",
        mintTxHash: "0xsent",
        attempt: 1,
      });
    });

    it("writes the position, the mint event and the recorded status together, and a replay returns the same position", async () => {
      const { intent } = await newIntent("record");
      await repository.recordEscrowMintSent({ intentId: intent.id, attempt: 1, txHash: "0xrecord" });

      const first = await repository.recordEscrowMintedPosition(recordInput("record", intent.id, "0xrecord"));
      const replay = await repository.recordEscrowMintedPosition(recordInput("record", intent.id, "0xrecord"));

      expect(replay.positionId).toBe(first.positionId);
      expect(await database.positionLedger.count({ where: { pivId: mintPivIds.record, accountId } })).toBe(1);
      const events = await database.chainSettlementEvent.findMany({ where: { chainTxHash: "0xrecord" } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        positionId: first.positionId,
        eventType: "mint",
        tokenContractAddress,
      });
      expect(events[0]?.tokenId.toFixed(0)).toBe(mintTokenId("record"));
      expect(await repository.findEscrowMintIntent(mintPivIds.record, accountId)).toMatchObject({
        status: "recorded",
        mintTxHash: "0xrecord",
      });
      const stored = await database.escrowMintIntent.findUniqueOrThrow({ where: { id: intent.id } });
      expect(stored.recordedAt).toEqual(activatedAt);
    });

    it("records nothing for an intent that is not at mint_sent with that hash", async () => {
      const { intent } = await newIntent("atomic");

      // Still `sending`: no hash has been recorded, so there is nothing to record a position for.
      await expect(
        repository.recordEscrowMintedPosition(recordInput("atomic", intent.id, "0xatomic")),
      ).rejects.toThrow(/not in 'mint_sent'/);

      await repository.recordEscrowMintSent({ intentId: intent.id, attempt: 1, txHash: "0xatomic" });
      // A hash that is not the one recorded for the intent.
      await expect(
        repository.recordEscrowMintedPosition(recordInput("atomic", intent.id, "0xnotthehash")),
      ).rejects.toThrow(/not in 'mint_sent'/);

      expect(await database.positionLedger.count({ where: { pivId: mintPivIds.atomic } })).toBe(0);
      expect(await database.chainSettlementEvent.count({ where: { chainTxHash: "0xnotthehash" } })).toBe(0);
      expect(await repository.findEscrowMintIntent(mintPivIds.atomic, accountId)).toMatchObject({
        status: "mint_sent",
      });
    });

    it("rolls the position and the recorded status back together when the mint event cannot be written", async () => {
      const { intent } = await newIntent("rollback");
      await repository.recordEscrowMintSent({ intentId: intent.id, attempt: 1, txHash: "0xrollback" });

      // A token id the event row rejects: the position insert before it has already run in the transaction.
      await expect(
        repository.recordEscrowMintedPosition({
          ...recordInput("rollback", intent.id, "0xrollback"),
          tokenId: "not-a-number",
        }),
      ).rejects.toThrow();

      expect(await database.positionLedger.count({ where: { pivId: mintPivIds.rollback } })).toBe(0);
      expect(await repository.findEscrowMintIntent(mintPivIds.rollback, accountId)).toMatchObject({
        status: "mint_sent",
        mintTxHash: "0xrollback",
      });
    });

    it("starts a new attempt with a compare-and-set, so only one of several racing runs gets it", async () => {
      const { intent } = await newIntent("restart");
      await repository.recordEscrowMintSent({ intentId: intent.id, attempt: 1, txHash: "0xold" });
      const restartAt = new Date("2026-10-18T13:00:00.000Z");

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          repository.restartEscrowMintAttempt({ intentId: intent.id, expectedAttempt: 1, attemptedAt: restartAt }),
        ),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await repository.findEscrowMintIntent(mintPivIds.restart, accountId)).toMatchObject({
        status: "sending",
        mintTxHash: null,
        attempt: 2,
        attemptedAt: restartAt,
        searchFromBlock: 1234n,
      });
      // A run still holding the old attempt can neither restart again nor record its stale hash.
      expect(
        await repository.restartEscrowMintAttempt({ intentId: intent.id, expectedAttempt: 1, attemptedAt: restartAt }),
      ).toBe(false);
      await expect(
        repository.recordEscrowMintSent({ intentId: intent.id, attempt: 1, txHash: "0xstale" }),
      ).rejects.toThrow();
      await repository.recordEscrowMintSent({ intentId: intent.id, attempt: 2, txHash: "0xnew" });
      expect(await repository.findEscrowMintIntent(mintPivIds.restart, accountId)).toMatchObject({
        status: "mint_sent",
        mintTxHash: "0xnew",
      });
    });
  });
});

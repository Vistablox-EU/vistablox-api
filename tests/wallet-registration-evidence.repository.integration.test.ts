import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaSettlementRepository } from "../src/modules/settlement/repository/prisma-settlement.repository.js";
import type { WalletRegistrationEvidence } from "../src/shared/domain/wallet-registration-evidence.js";
import { WalletRegistrationFixtures, deferred, withWriteHooks } from "./support/wallet-registration-db.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

const hex = (byte: string) => `0x${byte.repeat(32)}`;
const T0 = new Date("2026-11-13T10:00:00.000Z");
const T1 = new Date("2026-11-13T11:00:00.000Z");

function evidence(overrides: Partial<WalletRegistrationEvidence> = {}): WalletRegistrationEvidence {
  return { transactionHash: hex("11"), blockHash: hex("22"), blockNumber: 100n, logIndex: 3, ...overrides };
}
const keyOf = (value: WalletRegistrationEvidence) => ({
  transactionHash: value.transactionHash,
  blockHash: value.blockHash,
  logIndex: value.logIndex,
});

describe.skipIf(databaseUrl === undefined)("PrismaSettlementRepository wallet registration evidence (PostgreSQL)", () => {
  const database = createPrismaClient(databaseUrl ?? "");
  const repository = new PrismaSettlementRepository(database);
  const fixtures = new WalletRegistrationFixtures(database, databaseUrl ?? "");
  // Transaction hashes are unique per test run, so parallel suites and earlier
  // runs on the same database cannot collide on (transaction hash, log index).
  const uniqueTx = (tag: string) => fixtures.uniqueHash(tag);

  afterAll(async () => {
    await fixtures.cleanup();
    await database.$disconnect();
  });

  const read = (accountId: string) => database.walletRegistration.findUniqueOrThrow({ where: { accountId } });

  // The watcher confirms the claim it matched, so the call names the fixture
  // row's stored address and commitment (the compare-and-set).
  const confirmRegistration = (input: { accountId: string; registeredAt: Date; evidence: WalletRegistrationEvidence }) =>
    repository.confirmWalletRegistration({ ...input, ...fixtures.claimOf(input.accountId) });

  describe("confirmWalletRegistration", () => {
    it("writes registered_at and the whole identity in one row, lower-cased", async () => {
      const { accountId } = await fixtures.createRegistration();
      const tx = uniqueTx("a1");

      const outcome = await confirmRegistration({
        accountId,
        registeredAt: T0,
        evidence: evidence({ transactionHash: tx.toUpperCase().replace("0X", "0x"), blockHash: `0x${"AB".repeat(32)}` }),
      });

      expect(outcome).toBe("confirmed");
      expect(await read(accountId)).toMatchObject({
        registeredAt: T0,
        registrationTxHash: tx,
        registrationBlockHash: hex("ab"),
        registrationBlockNumber: 100n,
        registrationLogIndex: 3,
        registrationEvidenceVerifiedAt: null,
        registrationEvidenceFlag: null,
      });
    });

    it("leaves the row exactly as it was when the same or another event confirms it again", async () => {
      const { accountId } = await fixtures.createRegistration();
      const first = evidence({ transactionHash: uniqueTx("a2") });
      await confirmRegistration({ accountId, registeredAt: T0, evidence: first });
      const before = await read(accountId);

      const replay = await confirmRegistration({ accountId, registeredAt: T1, evidence: first });
      const other = await confirmRegistration({
        accountId,
        registeredAt: T1,
        evidence: evidence({ transactionHash: uniqueTx("a2b"), logIndex: 9 }),
      });

      expect([replay, other]).toEqual(["already_registered", "already_registered"]);
      expect(await read(accountId)).toEqual(before);
    });

    it("lets exactly one of several concurrent confirmations win, and keeps the winner's evidence whole", async () => {
      const { accountId } = await fixtures.createRegistration();
      const attempts = [1, 2, 3, 4].map((n) =>
        evidence({ transactionHash: uniqueTx(`b${n}`), blockHash: hex(`0${n}`), blockNumber: BigInt(200 + n), logIndex: n }),
      );

      const outcomes = await Promise.all(
        attempts.map((attempt) => confirmRegistration({ accountId, registeredAt: T0, evidence: attempt })),
      );

      expect(outcomes.filter((outcome) => outcome === "confirmed")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === "already_registered")).toHaveLength(3);
      const stored = await read(accountId);
      const winner = attempts.find((attempt) => attempt.transactionHash === stored.registrationTxHash);
      expect(winner).toBeDefined();
      expect(stored).toMatchObject({
        registrationBlockHash: winner!.blockHash,
        registrationBlockNumber: winner!.blockNumber,
        registrationLogIndex: winner!.logIndex,
      });
    });

    it("lets one of two accounts confirm the same event and leaves the other pending with no evidence", async () => {
      const a = await fixtures.createRegistration();
      const b = await fixtures.createRegistration();
      const shared = evidence({ transactionHash: uniqueTx("c1") });

      const outcomes = await Promise.all([
        confirmRegistration({ accountId: a.accountId, registeredAt: T0, evidence: shared }),
        confirmRegistration({ accountId: b.accountId, registeredAt: T0, evidence: shared }),
      ]);

      expect([...outcomes].sort()).toEqual(["confirmed", "event_taken"]);
      const loser = outcomes[0] === "event_taken" ? a : b;
      expect(await read(loser.accountId)).toMatchObject({
        registeredAt: null,
        registrationTxHash: null,
        registrationBlockHash: null,
        registrationBlockNumber: null,
        registrationLogIndex: null,
      });
    });

    it("confirms two accounts from the same transaction when their log indexes differ", async () => {
      const a = await fixtures.createRegistration();
      const b = await fixtures.createRegistration();
      const tx = uniqueTx("d1");

      const first = await confirmRegistration({
        accountId: a.accountId,
        registeredAt: T0,
        evidence: evidence({ transactionHash: tx, logIndex: 3 }),
      });
      const second = await confirmRegistration({
        accountId: b.accountId,
        registeredAt: T0,
        evidence: evidence({ transactionHash: tx, logIndex: 5 }),
      });

      expect([first, second]).toEqual(["confirmed", "confirmed"]);
    });

    it("rethrows a failure that is not the event conflict", async () => {
      const { accountId } = await fixtures.createRegistration();

      await expect(
        confirmRegistration({
          accountId,
          registeredAt: T0,
          evidence: evidence({ transactionHash: "0xnothex", logIndex: 1 }),
        }),
      ).rejects.toThrow();
      expect((await read(accountId)).registeredAt).toBeNull();
    });
  });

  describe("replaceWalletRegistrationEvidence", () => {
    async function confirmed(tag: string, overrides: Partial<WalletRegistrationEvidence> = {}) {
      const registration = await fixtures.createRegistration();
      const initial = evidence({ transactionHash: uniqueTx(tag), ...overrides });
      await confirmRegistration({ accountId: registration.accountId, registeredAt: T0, evidence: initial });
      return { ...registration, initial };
    }

    it("replaces the identity, clears verification and flag, keeps registered_at and writes one audit row", async () => {
      const { accountId, initial } = await confirmed("e1");
      await repository.markWalletRegistrationEvidenceVerified({ accountId, expected: keyOf(initial), verifiedAt: T0 });
      const next = evidence({ transactionHash: initial.transactionHash, blockHash: hex("33"), blockNumber: 101n, logIndex: 6 });

      const outcome = await repository.replaceWalletRegistrationEvidence({
        accountId,
        expected: keyOf(initial),
        next,
        reason: "refreshed",
        changedAt: T1,
      });

      expect(outcome).toBe("replaced");
      expect(await read(accountId)).toMatchObject({
        registeredAt: T0,
        registrationTxHash: next.transactionHash,
        registrationBlockHash: hex("33"),
        registrationBlockNumber: 101n,
        registrationLogIndex: 6,
        registrationEvidenceVerifiedAt: null,
        registrationEvidenceFlaggedAt: null,
        registrationEvidenceFlag: null,
      });
      const audit = await database.auditLog.findMany({
        where: { resourceType: "wallet_registration", resourceId: accountId, action: { startsWith: "settlement.wallet_registration_evidence_" } },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: "settlement.wallet_registration_evidence_refreshed", actorAccountId: null, createdAt: T1 });
      expect(audit[0]!.changes).toMatchObject({
        previous: { tx_hash: initial.transactionHash, block_hash: hex("22"), block_number: "100", log_index: 3 },
        next: { tx_hash: next.transactionHash, block_hash: hex("33"), block_number: "101", log_index: 6 },
        previous_flag: null,
      });
    });

    it("clears the flag and its timestamp on a flagged row and keeps the flag it had in the audit row", async () => {
      const { accountId, initial } = await confirmed("e1f");
      await repository.flagWalletRegistrationEvidence({
        accountId,
        expected: keyOf(initial),
        flag: "transaction_missing",
        flaggedAt: T0,
      });
      expect(await read(accountId)).toMatchObject({ registrationEvidenceFlag: "transaction_missing", registrationEvidenceFlaggedAt: T0 });
      const next = evidence({ transactionHash: initial.transactionHash, blockHash: hex("34"), blockNumber: 102n, logIndex: 7 });

      const outcome = await repository.replaceWalletRegistrationEvidence({
        accountId,
        expected: keyOf(initial),
        next,
        reason: "refreshed",
        changedAt: T1,
      });

      expect(outcome).toBe("replaced");
      expect(await read(accountId)).toMatchObject({
        registeredAt: T0,
        registrationBlockHash: hex("34"),
        registrationBlockNumber: 102n,
        registrationLogIndex: 7,
        registrationEvidenceVerifiedAt: null,
        registrationEvidenceFlaggedAt: null,
        registrationEvidenceFlag: null,
      });
      expect(await fixtures.auditActions(accountId)).toEqual([
        "settlement.wallet_registration_evidence_flagged",
        "settlement.wallet_registration_evidence_refreshed",
      ]);
      const refreshed = await database.auditLog.findFirstOrThrow({
        where: { resourceId: accountId, action: "settlement.wallet_registration_evidence_refreshed" },
      });
      expect(refreshed.changes).toEqual({
        previous: { tx_hash: initial.transactionHash, block_hash: hex("22"), block_number: "100", log_index: 3 },
        next: { tx_hash: next.transactionHash, block_hash: hex("34"), block_number: "102", log_index: 7 },
        previous_flag: "transaction_missing",
      });
    });

    it("clears the flag when the flagged row's own event is replaced by the identical identity", async () => {
      const { accountId, initial } = await confirmed("e1g");
      await repository.flagWalletRegistrationEvidence({ accountId, expected: keyOf(initial), flag: "event_missing", flaggedAt: T0 });

      const outcome = await repository.replaceWalletRegistrationEvidence({
        accountId,
        expected: keyOf(initial),
        next: initial,
        reason: "refreshed",
        changedAt: T1,
      });

      expect(outcome).toBe("replaced");
      expect(await read(accountId)).toMatchObject({
        registrationTxHash: initial.transactionHash,
        registrationBlockHash: initial.blockHash,
        registrationLogIndex: initial.logIndex,
        registrationEvidenceFlaggedAt: null,
        registrationEvidenceFlag: null,
      });
    });

    it("records evidence on a row that was confirmed without any and says so in the audit row", async () => {
      const registration = await fixtures.createRegistration({ registeredAt: T0 });
      const next = evidence({ transactionHash: uniqueTx("e2") });

      const outcome = await repository.replaceWalletRegistrationEvidence({
        accountId: registration.accountId,
        expected: { transactionHash: null, blockHash: null, logIndex: null },
        next,
        reason: "recorded",
        changedAt: T1,
      });

      expect(outcome).toBe("replaced");
      const stored = await read(registration.accountId);
      expect(stored).toMatchObject({ registeredAt: T0, registrationTxHash: next.transactionHash, registrationLogIndex: 3 });
      expect(await fixtures.auditActions(registration.accountId)).toEqual(["settlement.wallet_registration_evidence_recorded"]);
      const audit = await database.auditLog.findFirstOrThrow({
        where: { resourceId: registration.accountId, action: { startsWith: "settlement.wallet_registration_evidence_" } },
      });
      expect((audit.changes as { previous: unknown }).previous).toBeNull();
    });

    it("completes a row that has only a transaction hash and block number", async () => {
      const registration = await fixtures.createRegistration({ registeredAt: T0 });
      const tx = uniqueTx("e3");
      await database.walletRegistration.update({
        where: { accountId: registration.accountId },
        data: { registrationTxHash: tx, registrationBlockNumber: 90n },
      });

      const outcome = await repository.replaceWalletRegistrationEvidence({
        accountId: registration.accountId,
        expected: { transactionHash: tx, blockHash: null, logIndex: null },
        next: evidence({ transactionHash: tx }),
        reason: "recorded",
        changedAt: T1,
      });

      expect(outcome).toBe("replaced");
      expect(await read(registration.accountId)).toMatchObject({ registrationBlockNumber: 100n, registrationLogIndex: 3 });
    });

    it("does nothing and writes no audit row when the row no longer holds the expected identity", async () => {
      const { accountId, initial } = await confirmed("e4");
      const before = await read(accountId);

      const outcome = await repository.replaceWalletRegistrationEvidence({
        accountId,
        expected: { ...keyOf(initial), blockHash: hex("99") },
        next: evidence({ transactionHash: uniqueTx("e4x") }),
        reason: "refreshed",
        changedAt: T1,
      });

      expect(outcome).toBe("stale");
      expect(await read(accountId)).toEqual(before);
      expect(await fixtures.auditActions(accountId)).toEqual([]);
    });

    it("does nothing for a row that is not registered", async () => {
      const registration = await fixtures.createRegistration();

      const outcome = await repository.replaceWalletRegistrationEvidence({
        accountId: registration.accountId,
        expected: { transactionHash: null, blockHash: null, logIndex: null },
        next: evidence({ transactionHash: uniqueTx("e5") }),
        reason: "recorded",
        changedAt: T1,
      });

      expect(outcome).toBe("stale");
      expect((await read(registration.accountId)).registrationTxHash).toBeNull();
    });

    it("reports event_taken, and leaves the row and the audit log alone, when another row holds the new identity", async () => {
      const holder = await confirmed("e6", { logIndex: 4 });
      const mover = await confirmed("e6m", { logIndex: 9 });
      const before = await read(mover.accountId);

      const outcome = await repository.replaceWalletRegistrationEvidence({
        accountId: mover.accountId,
        expected: keyOf(mover.initial),
        next: holder.initial,
        reason: "refreshed",
        changedAt: T1,
      });

      expect(outcome).toBe("event_taken");
      expect(await read(mover.accountId)).toEqual(before);
      expect(await fixtures.auditActions(mover.accountId)).toEqual([]);
    });

    it("rolls the evidence back when the audit row cannot be written", async () => {
      const { accountId, initial } = await confirmed("e7");
      const before = await read(accountId);

      await expect(
        repository.replaceWalletRegistrationEvidence({
          accountId,
          expected: keyOf(initial),
          next: evidence({ transactionHash: initial.transactionHash, blockHash: hex("44") }),
          reason: "refreshed",
          changedAt: new Date(Number.NaN),
        }),
      ).rejects.toThrow();

      expect(await read(accountId)).toEqual(before);
    });

    it("waits for a concurrent change and then finds the row no longer as it was read (stale), without overwriting it", async () => {
      const { accountId, initial } = await confirmed("e9");
      const concurrent = evidence({ transactionHash: initial.transactionHash, blockHash: hex("61"), logIndex: 7 });
      let result: Promise<string> | undefined;

      await fixtures.withRowLocked(
        accountId,
        async () => {
          result = repository.replaceWalletRegistrationEvidence({
            accountId,
            expected: keyOf(initial),
            next: evidence({ transactionHash: initial.transactionHash, blockHash: hex("62"), logIndex: 8 }),
            reason: "refreshed",
            changedAt: T1,
          });
          const state = await Promise.race([result.then(() => "finished"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 300))]);
          expect(state).toBe("waiting");
        },
        async (transaction) => {
          await transaction.walletRegistration.update({
            where: { accountId },
            data: { registrationBlockHash: concurrent.blockHash, registrationLogIndex: concurrent.logIndex },
          });
        },
      );

      expect(await result).toBe("stale");
      expect(await read(accountId)).toMatchObject({ registrationBlockHash: hex("61"), registrationLogIndex: 7 });
      expect(await fixtures.auditActions(accountId)).toEqual([]);
    });

    it("replaces the evidence of exactly one of two concurrent refreshes", async () => {
      const { accountId, initial } = await confirmed("e8");
      const attempt = (blockHash: string, logIndex: number) =>
        repository.replaceWalletRegistrationEvidence({
          accountId,
          expected: keyOf(initial),
          next: evidence({ transactionHash: initial.transactionHash, blockHash, logIndex }),
          reason: "refreshed",
          changedAt: T1,
        });

      const outcomes = await Promise.all([attempt(hex("51"), 1), attempt(hex("52"), 2)]);

      expect([...outcomes].sort()).toEqual(["replaced", "stale"]);
      expect(await fixtures.auditActions(accountId)).toHaveLength(1);
    });
  });

  describe("verified and flagged", () => {
    async function confirmed(tag: string) {
      const registration = await fixtures.createRegistration();
      const initial = evidence({ transactionHash: uniqueTx(tag) });
      await confirmRegistration({ accountId: registration.accountId, registeredAt: T0, evidence: initial });
      return { ...registration, initial };
    }

    it("marks an unflagged, unverified confirmation verified once", async () => {
      const { accountId, initial } = await confirmed("f1");

      const first = await repository.markWalletRegistrationEvidenceVerified({ accountId, expected: keyOf(initial), verifiedAt: T1 });
      const second = await repository.markWalletRegistrationEvidenceVerified({ accountId, expected: keyOf(initial), verifiedAt: T0 });

      expect([first, second]).toEqual([true, false]);
      expect((await read(accountId)).registrationEvidenceVerifiedAt).toEqual(T1);
    });

    it("does not verify against a different identity or a flagged row", async () => {
      const { accountId, initial } = await confirmed("f2");

      expect(
        await repository.markWalletRegistrationEvidenceVerified({
          accountId,
          expected: { ...keyOf(initial), logIndex: 99 },
          verifiedAt: T1,
        }),
      ).toBe(false);
      await repository.flagWalletRegistrationEvidence({ accountId, expected: keyOf(initial), flag: "event_missing", flaggedAt: T1 });
      expect(await repository.markWalletRegistrationEvidenceVerified({ accountId, expected: keyOf(initial), verifiedAt: T1 })).toBe(false);
    });

    it("flags a confirmation without touching registered_at, writes the audit row, and ignores a second flag", async () => {
      const { accountId, initial } = await confirmed("f3");

      const first = await repository.flagWalletRegistrationEvidence({
        accountId,
        expected: keyOf(initial),
        flag: "transaction_missing",
        flaggedAt: T1,
      });
      const second = await repository.flagWalletRegistrationEvidence({
        accountId,
        expected: keyOf(initial),
        flag: "event_missing",
        flaggedAt: new Date("2026-11-13T12:00:00.000Z"),
      });

      expect([first, second]).toEqual([true, false]);
      expect(await read(accountId)).toMatchObject({
        registeredAt: T0,
        registrationEvidenceFlag: "transaction_missing",
        registrationEvidenceFlaggedAt: T1,
        registrationTxHash: initial.transactionHash,
      });
      expect(await fixtures.auditActions(accountId)).toEqual(["settlement.wallet_registration_evidence_flagged"]);
      const audit = await database.auditLog.findFirstOrThrow({
        where: { resourceType: "wallet_registration", resourceId: accountId, action: { startsWith: "settlement.wallet_registration_evidence_" } },
      });
      expect(audit).toMatchObject({ actorAccountId: null, createdAt: T1 });
      expect(audit.changes).toEqual({
        flag: "transaction_missing",
        tx_hash: initial.transactionHash,
        block_hash: initial.blockHash,
        block_number: "100",
        log_index: 3,
      });
    });

    it("does not flag over a row that changed while it waited for the lock", async () => {
      const { accountId, initial } = await confirmed("f5");
      let result: Promise<boolean> | undefined;

      await fixtures.withRowLocked(
        accountId,
        async () => {
          result = repository.flagWalletRegistrationEvidence({
            accountId,
            expected: keyOf(initial),
            flag: "event_missing",
            flaggedAt: T1,
          });
          const state = await Promise.race([result.then(() => "finished"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 300))]);
          expect(state).toBe("waiting");
        },
        async (transaction) => {
          await transaction.walletRegistration.update({ where: { accountId }, data: { registrationBlockHash: hex("71") } });
        },
      );

      expect(await result).toBe(false);
      expect((await read(accountId)).registrationEvidenceFlag).toBeNull();
    });

    it("rolls the flag back when the audit row cannot be written", async () => {
      const { accountId, initial } = await confirmed("f6");
      const before = await read(accountId);
      const auditFails = new PrismaSettlementRepository(withWriteHooks(database, { failAuditWrite: new Error("audit write failed") }));

      await expect(
        auditFails.flagWalletRegistrationEvidence({ accountId, expected: keyOf(initial), flag: "transaction_missing", flaggedAt: T1 }),
      ).rejects.toThrow("audit write failed");

      expect(await read(accountId)).toEqual(before);
      expect(await fixtures.auditActions(accountId)).toEqual([]);
      // Nothing was left half done: the row can still be flagged, once, with its audit row.
      expect(await repository.flagWalletRegistrationEvidence({ accountId, expected: keyOf(initial), flag: "transaction_missing", flaggedAt: T1 })).toBe(true);
      expect(await fixtures.auditActions(accountId)).toEqual(["settlement.wallet_registration_evidence_flagged"]);
    });

    it("keeps the row locked from its decision to its write, so a second flag waits and then finds the row flagged", async () => {
      const { accountId, initial } = await confirmed("f7");
      const reachedWrite = deferred();
      const releaseWrite = deferred();
      // The first flag stops right before its UPDATE, after it read the row as
      // unflagged: a second writer must not be able to get in at that point.
      const pausedBeforeUpdate = new PrismaSettlementRepository(
        withWriteHooks(database, {
          beforeRegistrationUpdate: async () => {
            reachedWrite.resolve();
            await releaseWrite.promise;
          },
        }),
      );

      let first: Promise<boolean> | undefined;
      let second: Promise<boolean> | undefined;
      try {
        first = pausedBeforeUpdate.flagWalletRegistrationEvidence({ accountId, expected: keyOf(initial), flag: "transaction_missing", flaggedAt: T1 });
        await reachedWrite.promise;

        second = repository.flagWalletRegistrationEvidence({
          accountId,
          expected: keyOf(initial),
          flag: "event_missing",
          flaggedAt: new Date("2026-11-13T12:00:00.000Z"),
        });
        const state = await Promise.race([second.then(() => "finished"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 300))]);
        expect(state).toBe("waiting");
      } finally {
        releaseWrite.resolve();
      }

      expect([await first, await second]).toEqual([true, false]);
      expect(await read(accountId)).toMatchObject({ registrationEvidenceFlag: "transaction_missing", registrationEvidenceFlaggedAt: T1 });
      expect(await fixtures.auditActions(accountId)).toEqual(["settlement.wallet_registration_evidence_flagged"]);
    });

    it("does not flag a row that holds another identity than the one the caller read", async () => {
      const { accountId, initial } = await confirmed("f4");

      const flagged = await repository.flagWalletRegistrationEvidence({
        accountId,
        expected: { ...keyOf(initial), blockHash: hex("99") },
        flag: "event_missing",
        flaggedAt: T1,
      });

      expect(flagged).toBe(false);
      expect((await read(accountId)).registrationEvidenceFlag).toBeNull();
      expect(await fixtures.auditActions(accountId)).toEqual([]);
    });
  });

  describe("listWalletRegistrationsForEvidenceRecheck", () => {
    it("lists only unverified, unflagged confirmations with a block hash, oldest block first, within the limit", async () => {
      const lowBlock = 9_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000));
      const make = async (tag: string, blockNumber: bigint) => {
        const registration = await fixtures.createRegistration();
        const initial = evidence({ transactionHash: uniqueTx(tag), blockNumber });
        await confirmRegistration({ accountId: registration.accountId, registeredAt: T0, evidence: initial });
        return { ...registration, initial };
      };
      const third = await make("g3", lowBlock + 3n);
      const first = await make("g1", lowBlock + 1n);
      const second = await make("g2", lowBlock + 2n);
      const verified = await make("g4", lowBlock + 4n);
      const flagged = await make("g5", lowBlock + 5n);
      const pending = await fixtures.createRegistration();
      const legacy = await fixtures.createRegistration({ registeredAt: T0 });
      await database.walletRegistration.update({
        where: { accountId: legacy.accountId },
        data: { registrationTxHash: uniqueTx("g7"), registrationBlockNumber: lowBlock + 6n },
      });
      await repository.markWalletRegistrationEvidenceVerified({ accountId: verified.accountId, expected: keyOf(verified.initial), verifiedAt: T1 });
      await repository.flagWalletRegistrationEvidence({ accountId: flagged.accountId, expected: keyOf(flagged.initial), flag: "event_missing", flaggedAt: T1 });
      const ours = new Set([third, first, second, verified, flagged, pending, legacy].map((entry) => entry.accountId));

      // Other suites share this database, so only this test's rows are compared.
      const listed = (await repository.listWalletRegistrationsForEvidenceRecheck(10_000)).filter((candidate) => ours.has(candidate.accountId));

      expect(listed.map((candidate) => candidate.accountId)).toEqual([first.accountId, second.accountId, third.accountId]);
      expect(listed[0]).toMatchObject({
        walletAddress: first.walletAddress,
        registrationCommitment: first.commitment,
        evidence: first.initial,
      });
      expect(await repository.listWalletRegistrationsForEvidenceRecheck(1)).toHaveLength(1);
    });
  });

  describe("findWalletRegistrationByCommitment", () => {
    it("finds a row in any state, ignoring the case of the commitment", async () => {
      const pending = await fixtures.createRegistration({ commitment: `0xAbCdEf${fixtures.suffix}p` });
      const registered = await fixtures.createRegistration({ commitment: `0xAbCdEf${fixtures.suffix}r` });
      const initial = evidence({ transactionHash: uniqueTx("h1") });
      await confirmRegistration({ accountId: registered.accountId, registeredAt: T0, evidence: initial });

      expect(await repository.findWalletRegistrationByCommitment(`0xabcdef${fixtures.suffix}p`.toUpperCase().replace("0X", "0x"))).toEqual({
        accountId: pending.accountId,
        walletAddress: pending.walletAddress,
        registrationCommitment: pending.commitment,
        registeredAt: null,
        transactionHash: null,
        blockNumber: null,
        blockHash: null,
        logIndex: null,
        evidenceFlag: null,
      });
      expect(await repository.findWalletRegistrationByCommitment(`0xabcdef${fixtures.suffix}r`)).toEqual({
        accountId: registered.accountId,
        walletAddress: registered.walletAddress,
        registrationCommitment: registered.commitment,
        registeredAt: T0,
        transactionHash: initial.transactionHash,
        blockNumber: 100n,
        blockHash: initial.blockHash,
        logIndex: 3,
        evidenceFlag: null,
      });
      expect(await repository.findWalletRegistrationByCommitment(`0xnone${fixtures.suffix}`)).toBeNull();
    });

    it("returns the flag of a flagged row, which is what makes the watcher refresh it instead of treating the event as a replay", async () => {
      const row = await fixtures.createRegistration({ commitment: `0xflagged${fixtures.suffix}` });
      const initial = evidence({ transactionHash: uniqueTx("h2") });
      await confirmRegistration({ accountId: row.accountId, registeredAt: T0, evidence: initial });
      await repository.flagWalletRegistrationEvidence({
        accountId: row.accountId,
        expected: keyOf(initial),
        flag: "transaction_reverted",
        flaggedAt: T1,
      });

      expect(await repository.findWalletRegistrationByCommitment(`0xflagged${fixtures.suffix}`)).toEqual({
        accountId: row.accountId,
        walletAddress: row.walletAddress,
        registrationCommitment: row.commitment,
        registeredAt: T0,
        transactionHash: initial.transactionHash,
        blockNumber: 100n,
        blockHash: initial.blockHash,
        logIndex: 3,
        evidenceFlag: "transaction_reverted",
      });
    });
  });

  describe("CHECK constraints", () => {
    const registered = (tag: string) => fixtures.createRegistration({ registeredAt: T0, commitment: `0xchk${tag}${fixtures.suffix}` });
    const cannot = (accountId: string, set: string, params: unknown[] = []) =>
      expect(
        fixtures.query(`UPDATE settlement.wallet_registrations SET ${set} WHERE account_id = $1`, [accountId, ...params]),
      ).rejects.toMatchObject({ code: "23514" });

    it("rejects a block hash without a transaction hash, an upper-case hash, a negative log index, evidence on a pending row, half a flag and an unknown flag", async () => {
      const row = await registered("1");
      const pending = await fixtures.createRegistration();

      await cannot(row.accountId, "registration_block_hash = $2, registration_log_index = 1", [hex("22")]);
      await cannot(row.accountId, "registration_tx_hash = $2, registration_block_number = 1", [`0x${"AB".repeat(32)}`]);
      await cannot(
        row.accountId,
        "registration_tx_hash = $2, registration_block_number = 1, registration_block_hash = $3, registration_log_index = -1",
        [hex("11"), hex("22")],
      );
      await cannot(
        pending.accountId,
        "registration_tx_hash = $2, registration_block_number = 1",
        [hex("11")],
      );
      await cannot(row.accountId, "registration_evidence_flag = 'event_missing'");
      await cannot(
        row.accountId,
        "registration_tx_hash = $2, registration_block_number = 1, registration_block_hash = $3, registration_log_index = 1, registration_evidence_flag = 'bogus', registration_evidence_flagged_at = now()",
        [hex("11"), hex("22")],
      );
      await cannot(row.accountId, "registration_evidence_verified_at = now()");
    });

    it("still accepts the shapes written before this change: a transaction hash with a block number, or nothing", async () => {
      const row = await registered("2");

      await fixtures.query(
        "UPDATE settlement.wallet_registrations SET registration_tx_hash = $2, registration_block_number = 7 WHERE account_id = $1",
        [row.accountId, uniqueTx("k1")],
      );
      await fixtures.query(
        "UPDATE settlement.wallet_registrations SET registration_tx_hash = NULL, registration_block_number = NULL WHERE account_id = $1",
        [row.accountId],
      );
    });
  });
});

import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaWalletRepository } from "../src/modules/wallet/repository/prisma-wallet.repository.js";
import type { ReconcileWalletRegistrationInput } from "../src/modules/wallet/repository/wallet.repository.js";
import type { WalletRegistrationEvidence } from "../src/shared/domain/wallet-registration-evidence.js";
import { WalletRegistrationFixtures, deferred, withWriteHooks } from "./support/wallet-registration-db.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

const hex = (byte: string) => `0x${byte.repeat(32)}`;
const CHAIN_TIME = new Date("2026-11-13T09:00:00.000Z");
const NOW = new Date("2026-11-13T12:00:00.000Z");
const EARLIER = new Date("2026-11-13T10:00:00.000Z");

describe.skipIf(databaseUrl === undefined)("PrismaWalletRepository.reconcileWalletRegistration (PostgreSQL)", () => {
  const database = createPrismaClient(databaseUrl ?? "");
  const repository = new PrismaWalletRepository(database);
  const fixtures = new WalletRegistrationFixtures(database, databaseUrl ?? "");

  afterAll(async () => {
    await fixtures.cleanup();
    await database.$disconnect();
  });

  const evidenceFor = (tag: string, overrides: Partial<WalletRegistrationEvidence> = {}): WalletRegistrationEvidence => ({
    transactionHash: fixtures.uniqueHash(tag),
    blockHash: hex("22"),
    blockNumber: 100n,
    logIndex: 3,
    ...overrides,
  });
  // The audit row's actor must be a real account (foreign key): a registration
  // fixture's account stands in for the staff member.
  let sharedActor: Promise<string> | undefined;
  const defaultActor = () => (sharedActor ??= fixtures.createRegistration().then((registration) => registration.accountId));
  const reconcile = async (
    accountId: string,
    evidence: WalletRegistrationEvidence,
    overrides: Partial<ReconcileWalletRegistrationInput> = {},
    using: PrismaWalletRepository = repository,
  ) => {
    const reconcileWalletRegistration = using.reconcileWalletRegistration;
    return reconcileWalletRegistration.call(using, {
      accountId,
      actorAccountId: await defaultActor(),
      evidence,
      registeredAt: CHAIN_TIME,
      changedAt: NOW,
      ...overrides,
    });
  };
  const read = (accountId: string) => database.walletRegistration.findUniqueOrThrow({ where: { accountId } });

  const staffAccount = () => defaultActor();

  async function registeredWith(tag: string, overrides: Partial<WalletRegistrationEvidence> = {}) {
    const registration = await fixtures.createRegistration({ registeredAt: EARLIER });
    const evidence = evidenceFor(tag, overrides);
    await database.walletRegistration.update({
      where: { accountId: registration.accountId },
      data: {
        registrationTxHash: evidence.transactionHash,
        registrationBlockNumber: evidence.blockNumber,
        registrationBlockHash: evidence.blockHash,
        registrationLogIndex: evidence.logIndex,
      },
    });
    return { ...registration, evidence };
  }

  it("confirms a pending registration with the evidence, the existing audit action, and the audit row stamped now", async () => {
    const actorAccountId = await staffAccount();
    const { accountId } = await fixtures.createRegistration();
    const evidence = evidenceFor("r1");

    const result = await reconcile(accountId, evidence, { actorAccountId });

    expect(result).toMatchObject({ kind: "reconciled", outcome: "confirmed" });
    expect(await read(accountId)).toMatchObject({
      registeredAt: CHAIN_TIME,
      registrationTxHash: evidence.transactionHash,
      registrationBlockHash: evidence.blockHash,
      registrationBlockNumber: 100n,
      registrationLogIndex: 3,
    });
    const audit = await database.auditLog.findFirstOrThrow({ where: { resourceType: "wallet_registration", resourceId: accountId } });
    expect(audit).toMatchObject({ action: "settlement.wallet_registration_reconciled", actorAccountId, createdAt: NOW });
    expect(audit.changes).toMatchObject({
      tx_hash: evidence.transactionHash,
      block_hash: evidence.blockHash,
      block_number: "100",
      log_index: 3,
      registered_at: CHAIN_TIME.toISOString(),
    });
  });

  it("changes nothing and writes no audit row when the row already holds exactly this event", async () => {
    const row = await registeredWith("r2");
    const before = await read(row.accountId);

    const result = await reconcile(row.accountId, row.evidence);

    expect(result).toMatchObject({ kind: "reconciled", outcome: "unchanged" });
    expect(await read(row.accountId)).toEqual(before);
    expect(await fixtures.auditActions(row.accountId)).toEqual([]);
  });

  it("records the evidence on a registration that was confirmed without any, leaving registered_at alone", async () => {
    const actorAccountId = await staffAccount();
    const registration = await fixtures.createRegistration({ registeredAt: EARLIER });
    const evidence = evidenceFor("r3");

    const result = await reconcile(registration.accountId, evidence, { actorAccountId });

    expect(result).toMatchObject({ kind: "reconciled", outcome: "evidence_recorded" });
    expect(await read(registration.accountId)).toMatchObject({ registeredAt: EARLIER, registrationTxHash: evidence.transactionHash, registrationLogIndex: 3 });
    expect(await fixtures.auditActions(registration.accountId)).toEqual(["settlement.wallet_registration_evidence_recorded"]);
  });

  it("completes a registration that has only a transaction hash and block number from the same transaction", async () => {
    const registration = await fixtures.createRegistration({ registeredAt: EARLIER });
    const evidence = evidenceFor("r4");
    await database.walletRegistration.update({
      where: { accountId: registration.accountId },
      data: { registrationTxHash: evidence.transactionHash, registrationBlockNumber: 90n },
    });

    const result = await reconcile(registration.accountId, evidence);

    expect(result).toMatchObject({ kind: "reconciled", outcome: "evidence_recorded" });
    expect(await read(registration.accountId)).toMatchObject({ registrationBlockNumber: 100n, registrationBlockHash: evidence.blockHash, registrationLogIndex: 3, registeredAt: EARLIER });
  });

  it("refuses a different event for a legacy row that holds another transaction hash, and for an unflagged complete row", async () => {
    const legacy = await fixtures.createRegistration({ registeredAt: EARLIER });
    const legacyTx = fixtures.uniqueHash("r5a");
    await database.walletRegistration.update({
      where: { accountId: legacy.accountId },
      data: { registrationTxHash: legacyTx, registrationBlockNumber: 90n },
    });
    const complete = await registeredWith("r5b");
    const beforeLegacy = await read(legacy.accountId);
    const beforeComplete = await read(complete.accountId);

    const legacyResult = await reconcile(legacy.accountId, evidenceFor("r5x"));
    const completeResult = await reconcile(complete.accountId, evidenceFor("r5y"));

    expect(legacyResult).toEqual({ kind: "conflict", reason: "different_event" });
    expect(completeResult).toEqual({ kind: "conflict", reason: "different_event" });
    expect(await read(legacy.accountId)).toEqual(beforeLegacy);
    expect(await read(complete.accountId)).toEqual(beforeComplete);
    expect(await fixtures.auditActions(complete.accountId)).toEqual([]);
  });

  it("replaces the evidence when the same transaction was mined in another block", async () => {
    const actorAccountId = await staffAccount();
    const row = await registeredWith("r6");
    const next = { ...row.evidence, blockHash: hex("33"), blockNumber: 101n, logIndex: 8 };

    const result = await reconcile(row.accountId, next, { actorAccountId });

    expect(result).toMatchObject({ kind: "reconciled", outcome: "evidence_replaced" });
    expect(await read(row.accountId)).toMatchObject({ registeredAt: EARLIER, registrationBlockHash: hex("33"), registrationBlockNumber: 101n, registrationLogIndex: 8 });
    const audit = await database.auditLog.findFirstOrThrow({ where: { resourceId: row.accountId } });
    expect(audit).toMatchObject({ action: "settlement.wallet_registration_evidence_replaced", actorAccountId });
    expect(audit.changes).toMatchObject({
      previous: { tx_hash: row.evidence.transactionHash, block_hash: hex("22"), block_number: "100", log_index: 3 },
      next: { block_hash: hex("33"), block_number: "101", log_index: 8 },
      previous_flag: null,
    });
  });

  it("replaces the evidence of a flagged registration with a verified event, clears the flag and keeps it in the audit row", async () => {
    const row = await registeredWith("r7");
    await database.walletRegistration.update({
      where: { accountId: row.accountId },
      data: { registrationEvidenceFlaggedAt: EARLIER, registrationEvidenceFlag: "transaction_missing", registrationEvidenceVerifiedAt: null },
    });
    const replacement = evidenceFor("r7b");

    const result = await reconcile(row.accountId, replacement);

    expect(result).toMatchObject({ kind: "reconciled", outcome: "evidence_replaced" });
    expect(await read(row.accountId)).toMatchObject({
      registeredAt: EARLIER,
      registrationTxHash: replacement.transactionHash,
      registrationEvidenceFlag: null,
      registrationEvidenceFlaggedAt: null,
    });
    const audit = await database.auditLog.findFirstOrThrow({ where: { resourceId: row.accountId } });
    expect(audit.changes).toMatchObject({ previous_flag: "transaction_missing" });
  });

  it("re-confirms the identical event of a flagged registration, which clears the flag", async () => {
    const row = await registeredWith("r8");
    await database.walletRegistration.update({
      where: { accountId: row.accountId },
      data: { registrationEvidenceFlaggedAt: EARLIER, registrationEvidenceFlag: "event_missing" },
    });

    const result = await reconcile(row.accountId, row.evidence);

    expect(result).toMatchObject({ kind: "reconciled", outcome: "evidence_replaced" });
    expect((await read(row.accountId)).registrationEvidenceFlag).toBeNull();
  });

  it("rolls everything back when the event backs another account's registration", async () => {
    const holder = await registeredWith("r9");
    const pending = await fixtures.createRegistration();
    const flagged = await registeredWith("r9f");
    await database.walletRegistration.update({
      where: { accountId: flagged.accountId },
      data: { registrationEvidenceFlaggedAt: EARLIER, registrationEvidenceFlag: "event_missing" },
    });
    const beforeFlagged = await read(flagged.accountId);

    const pendingResult = await reconcile(pending.accountId, holder.evidence);
    const flaggedResult = await reconcile(flagged.accountId, holder.evidence);

    expect(pendingResult).toEqual({ kind: "conflict", reason: "event_taken" });
    expect(flaggedResult).toEqual({ kind: "conflict", reason: "event_taken" });
    expect(await read(pending.accountId)).toMatchObject({ registeredAt: null, registrationTxHash: null, registrationBlockHash: null });
    expect(await read(flagged.accountId)).toEqual(beforeFlagged);
    expect(await fixtures.auditActions(pending.accountId)).toEqual([]);
    expect(await fixtures.auditActions(flagged.accountId)).toEqual([]);
  });

  it("lets exactly one of two concurrent reconciles with different valid events win, with consistent evidence", async () => {
    const { accountId } = await fixtures.createRegistration();
    const a = evidenceFor("r10a", { blockHash: hex("a1"), blockNumber: 301n, logIndex: 1 });
    const b = evidenceFor("r10b", { blockHash: hex("b1"), blockNumber: 302n, logIndex: 2 });

    const results = await Promise.all([reconcile(accountId, a), reconcile(accountId, b)]);

    expect(results.map((result) => result.kind === "reconciled" ? result.outcome : result.kind === "conflict" ? result.reason : result.kind).sort()).toEqual(["confirmed", "different_event"]);
    const stored = await read(accountId);
    const winner = stored.registrationTxHash === a.transactionHash ? a : b;
    expect(stored).toMatchObject({ registrationBlockHash: winner.blockHash, registrationBlockNumber: winner.blockNumber, registrationLogIndex: winner.logIndex });
    expect(await fixtures.auditActions(accountId)).toHaveLength(1);
  });

  it("waits for a concurrent change to the row and decides on what it finds, not on what it read first", async () => {
    const { accountId } = await fixtures.createRegistration();
    const other = evidenceFor("r13o");
    const mine = evidenceFor("r13m");
    let result: ReturnType<typeof reconcile> | undefined;

    await fixtures.withRowLocked(
      accountId,
      async () => {
        result = reconcile(accountId, mine);
        const state = await Promise.race([result.then(() => "finished"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 300))]);
        expect(state).toBe("waiting");
      },
      async (transaction) => {
        await transaction.walletRegistration.update({
          where: { accountId },
          data: {
            registeredAt: EARLIER,
            registrationTxHash: other.transactionHash,
            registrationBlockNumber: other.blockNumber,
            registrationBlockHash: other.blockHash,
            registrationLogIndex: other.logIndex,
          },
        });
      },
    );

    expect(await result).toEqual({ kind: "conflict", reason: "different_event" });
    expect(await read(accountId)).toMatchObject({ registeredAt: EARLIER, registrationTxHash: other.transactionHash });
  });

  // The evidence and its audit row are written together or not at all. An
  // audit row that cannot be written (here: a created_at that is not a date)
  // must take the evidence write back with it, whichever way the row changes.
  describe("when the audit row cannot be written", () => {
    const cases: Array<{ name: string; outcome: string; prepare: () => Promise<{ accountId: string; evidence: WalletRegistrationEvidence }> }> = [
      {
        name: "a pending registration being confirmed",
        outcome: "confirmed",
        prepare: async () => ({ accountId: (await fixtures.createRegistration()).accountId, evidence: evidenceFor("a1") }),
      },
      {
        name: "a registration without evidence being recorded",
        outcome: "evidence_recorded",
        prepare: async () => ({
          accountId: (await fixtures.createRegistration({ registeredAt: EARLIER })).accountId,
          evidence: evidenceFor("a2"),
        }),
      },
      {
        name: "a registration whose evidence is being replaced",
        outcome: "evidence_replaced",
        prepare: async () => {
          const row = await registeredWith("a3");
          return { accountId: row.accountId, evidence: { ...row.evidence, blockHash: hex("33"), blockNumber: 101n } };
        },
      },
    ];

    it.each(cases)("leaves $name exactly as it was", async ({ outcome, prepare }) => {
      const { accountId, evidence } = await prepare();
      const before = await read(accountId);

      // Sanity: the same input does go through with a valid date, so it is the audit row that fails below.
      await expect(reconcile(accountId, evidence, { changedAt: new Date(Number.NaN) })).rejects.toThrow();

      expect(await read(accountId)).toEqual(before);
      expect(await fixtures.auditActions(accountId)).toEqual([]);
      expect(await reconcile(accountId, evidence)).toMatchObject({ kind: "reconciled", outcome });
      expect(await fixtures.auditActions(accountId)).toHaveLength(1);
    });
  });

  it("keeps the row locked from its decision to its write, so a second reconcile waits and then decides on the first one's result", async () => {
    const { accountId } = await fixtures.createRegistration();
    const first = evidenceFor("r14a", { blockHash: hex("a2"), blockNumber: 311n, logIndex: 1 });
    const second = evidenceFor("r14b", { blockHash: hex("b2"), blockNumber: 312n, logIndex: 2 });
    const reachedWrite = deferred();
    const releaseWrite = deferred();
    // The first reconcile stops right before its UPDATE: it has read the row as
    // pending and decided to confirm it, which is the moment a second writer
    // must not be able to get in.
    const pausedBeforeUpdate = new PrismaWalletRepository(
      withWriteHooks(database, {
        beforeRegistrationUpdate: async () => {
          reachedWrite.resolve();
          await releaseWrite.promise;
        },
      }),
    );

    let firstResult: ReturnType<typeof reconcile> | undefined;
    let secondResult: ReturnType<typeof reconcile> | undefined;
    try {
      firstResult = reconcile(accountId, first, {}, pausedBeforeUpdate);
      await reachedWrite.promise;

      secondResult = reconcile(accountId, second);
      const state = await Promise.race([secondResult.then(() => "finished"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 300))]);
      expect(state).toBe("waiting");
    } finally {
      releaseWrite.resolve();
    }

    expect(await firstResult).toMatchObject({ kind: "reconciled", outcome: "confirmed" });
    expect(await secondResult).toEqual({ kind: "conflict", reason: "different_event" });
    expect(await read(accountId)).toMatchObject({
      registrationTxHash: first.transactionHash,
      registrationBlockHash: first.blockHash,
      registrationBlockNumber: first.blockNumber,
      registrationLogIndex: first.logIndex,
    });
    expect(await fixtures.auditActions(accountId)).toEqual(["settlement.wallet_registration_reconciled"]);
  });

  it("reports an account that has no registration", async () => {
    expect(await reconcile("account_walletreg_missing", evidenceFor("r11"))).toEqual({ kind: "not_found" });
  });

  it("reads the evidence back through findByAccountId", async () => {
    const row = await registeredWith("r12");
    await database.walletRegistration.update({
      where: { accountId: row.accountId },
      data: { registrationEvidenceVerifiedAt: NOW },
    });

    const wallet = await repository.findByAccountId(row.accountId);

    expect(wallet).toMatchObject({
      walletAddress: row.walletAddress,
      registeredAt: EARLIER,
      registrationTxHash: row.evidence.transactionHash,
      registrationBlockNumber: 100n,
      registrationBlockHash: row.evidence.blockHash,
      registrationLogIndex: 3,
      registrationEvidenceVerifiedAt: NOW,
      registrationEvidenceFlaggedAt: null,
      registrationEvidenceFlag: null,
    });
  });

  it("reads the flag back through findByAccountId for a flagged registration", async () => {
    const row = await registeredWith("r13");
    await database.walletRegistration.update({
      where: { accountId: row.accountId },
      data: { registrationEvidenceFlaggedAt: NOW, registrationEvidenceFlag: "event_missing" },
    });

    const wallet = await repository.findByAccountId(row.accountId);

    expect(wallet).toMatchObject({
      registeredAt: EARLIER,
      registrationTxHash: row.evidence.transactionHash,
      registrationEvidenceVerifiedAt: null,
      registrationEvidenceFlaggedAt: NOW,
      registrationEvidenceFlag: "event_missing",
    });
  });
});

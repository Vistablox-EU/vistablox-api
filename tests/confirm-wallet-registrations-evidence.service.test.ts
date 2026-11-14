import { describe, expect, it, vi } from "vitest";

import { ConfirmWalletRegistrationsService } from "../src/modules/settlement/application/confirm-wallet-registrations.service.js";
import { WALLET_REGISTRY_EVIDENCE_FINAL_DEPTH } from "../src/modules/settlement/domain/wallet-registration-event.policy.js";
import type { WalletRegistrationEvidence } from "../src/shared/domain/wallet-registration-evidence.js";
import {
  FakeEvidenceReader,
  FakeWalletRegistrationRepository,
  confirmedRow,
  defaultBlockHash,
  defaultTransactionHash,
  hash,
  makeFakeChain,
  type FakeEvent,
  type FakeRegistrationSeed,
} from "./support/wallet-registration-fakes.js";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const WALLET = "0xabc";
const COMMITMENT = "0xc1";
const pendingSeed: FakeRegistrationSeed = { accountId: "acct_01", walletAddress: WALLET, commitment: COMMITMENT };

function harness(options: { latest: bigint; cursor: bigint | null; events?: FakeEvent[]; rows?: FakeRegistrationSeed[] }) {
  const { chain, getEventsCalls } = makeFakeChain({ latestBlock: options.latest, events: options.events ?? [] });
  const repository = new FakeWalletRegistrationRepository(options.rows ?? [], options.cursor);
  const reader = new FakeEvidenceReader();
  const service = new ConfirmWalletRegistrationsService(repository, chain as never, () => NOW, undefined, reader);
  return { service, repository, reader, getEventsCalls };
}

// The identity makeFakeChain gives the event at this block, as a stored row holds it.
function identityAt(blockNumber: bigint, logIndex = 0): WalletRegistrationEvidence {
  return {
    transactionHash: defaultTransactionHash(blockNumber),
    blockHash: defaultBlockHash(blockNumber),
    blockNumber,
    logIndex,
  };
}

const event95: FakeEvent = { blockNumber: 95n, wallet: "0xABC", commitment: "0xC1", logIndex: 0 };

describe("ConfirmWalletRegistrationsService: evidence persistence", () => {
  it("passes the event's identity to the confirmation, hashes lower-cased", async () => {
    const { service, repository } = harness({
      latest: 100n,
      cursor: 10n,
      rows: [pendingSeed],
      events: [
        {
          blockNumber: 50n,
          wallet: "0xABC",
          commitment: "0xC1",
          transactionHash: `0x${"AB".repeat(32)}`,
          blockHash: `0x${"CD".repeat(32)}`,
          logIndex: 4,
        },
      ],
    });

    const summary = await service.execute();

    expect(summary.registrationsConfirmed).toBe(1);
    expect(repository.row("acct_01")).toMatchObject({
      registeredAt: NOW,
      transactionHash: hash("ab"),
      blockHash: hash("cd"),
      blockNumber: 50n,
      logIndex: 4,
    });
  });

  it.each([
    ["a removed log", { removed: true }],
    ["no transaction hash", { transactionHash: null }],
    ["no block hash", { blockHash: null }],
    ["no log index", { logIndex: null }],
    ["a block hash that is not a hash", { blockHash: "0xnothex" }],
    ["a transaction hash of the wrong length", { transactionHash: `0x${"ab".repeat(31)}` }],
  ] satisfies Array<[string, Partial<FakeEvent>]>)(
    "does not confirm an event with %s, counts it and still advances the cursor",
    async (_label, identity) => {
      const { service, repository } = harness({
        latest: 100n,
        cursor: 10n,
        rows: [pendingSeed],
        events: [{ blockNumber: 50n, wallet: "0xABC", commitment: "0xC1", ...identity }],
      });

      const summary = await service.execute();

      expect(summary).toMatchObject({ eventsFound: 1, eventsWithoutIdentity: 1, registrationsConfirmed: 0 });
      expect(repository.row("acct_01").registeredAt).toBeNull();
      expect(repository.writes).toEqual([]);
      expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(97n);
    },
  );

  it("fails the run with the cursor where it was when the confirmation itself fails", async () => {
    const { service, repository } = harness({ latest: 100n, cursor: 10n, rows: [pendingSeed], events: [event95] });
    vi.spyOn(repository, "confirmWalletRegistration").mockRejectedValue(new Error("db down"));

    await expect(service.execute()).rejects.toThrow("db down");

    expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(10n);
  });
});

describe("ConfirmWalletRegistrationsService: replay", () => {
  it("counts the same event twice in one batch as one confirmation and one replay, not as unmatched", async () => {
    const { service, repository } = harness({ latest: 100n, cursor: 10n, rows: [pendingSeed], events: [event95, event95] });

    const summary = await service.execute();

    expect(summary).toMatchObject({ eventsFound: 2, registrationsConfirmed: 1, eventsReplayed: 1, unmatchedEvents: 0 });
    expect(repository.writesOf("confirm")).toHaveLength(1);
  });

  it("confirms once over consecutive runs that re-read the same event, without further writes", async () => {
    const { service, repository } = harness({ latest: 100n, cursor: 90n, rows: [pendingSeed], events: [event95] });

    const first = await service.execute();
    const second = await service.execute();
    const third = await service.execute();

    expect([first, second, third].map((summary) => summary.registrationsConfirmed)).toEqual([1, 0, 0]);
    expect([first, second, third].map((summary) => summary.eventsReplayed)).toEqual([0, 1, 1]);
    expect([first, second, third].map((summary) => summary.unmatchedEvents)).toEqual([0, 0, 0]);
    expect(repository.writes.map((write) => write.method)).toEqual(["confirm"]);
  });

  it("does not confirm twice when the run crashed after the confirmation but before the cursor write", async () => {
    const { service, repository } = harness({ latest: 100n, cursor: 90n, rows: [pendingSeed], events: [event95] });
    repository.failSetCursor = true;

    await expect(service.execute()).rejects.toThrow("cursor write failed");
    expect(repository.writesOf("confirm")).toHaveLength(1);
    expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(90n);

    repository.failSetCursor = false;
    const rerun = await service.execute();

    expect(rerun).toMatchObject({ registrationsConfirmed: 0, eventsReplayed: 1 });
    expect(repository.writesOf("confirm")).toHaveLength(1);
    expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(97n);
  });
});

describe("ConfirmWalletRegistrationsService: events for rows that are already registered", () => {
  it("records the evidence on a row that was confirmed before evidence was kept, leaving registered_at alone", async () => {
    const registeredAt = new Date("2026-10-01T00:00:00.000Z");
    const { service, repository } = harness({
      latest: 100n,
      cursor: 90n,
      rows: [{ ...pendingSeed, registeredAt }],
      events: [event95],
    });

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceRecorded: 1, registrationsConfirmed: 0, eventsReplayed: 0 });
    expect(repository.row("acct_01")).toMatchObject({ registeredAt, ...{ transactionHash: defaultTransactionHash(95n), logIndex: 0 } });
    expect(repository.writes.map((write) => write.method)).toEqual(["replace:recorded"]);
  });

  it("refreshes the evidence when the same transaction was mined again in another block", async () => {
    const { service, repository } = harness({
      latest: 100n,
      cursor: 90n,
      rows: [
        confirmedRow(pendingSeed, {
          transactionHash: defaultTransactionHash(95n),
          blockHash: hash("99"),
          blockNumber: 94n,
          logIndex: 7,
        }),
      ],
      events: [event95],
    });

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceRefreshed: 1, conflictingEvents: 0 });
    expect(repository.row("acct_01")).toMatchObject({ blockHash: defaultBlockHash(95n), blockNumber: 95n, logIndex: 0 });
    expect(repository.row("acct_01").registeredAt).not.toBeNull();
  });

  it("refreshes a flagged row whose recorded event is on the chain again and clears the flag", async () => {
    const { service, repository } = harness({
      latest: 100n,
      cursor: 90n,
      rows: [{ ...confirmedRow(pendingSeed, identityAt(95n)), flaggedAt: NOW, flag: "transaction_missing" }],
      events: [event95],
    });

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceRefreshed: 1, eventsReplayed: 0 });
    expect(repository.row("acct_01")).toMatchObject({ flag: null, flaggedAt: null });
    expect(repository.writesOf("replace:refreshed")[0]!.detail).toMatchObject({ previousFlag: "transaction_missing" });
  });

  it("leaves a registration confirmed by one transaction alone when a different transaction emits the event", async () => {
    const original = { ...identityAt(60n), transactionHash: hash("77") };
    const { service, repository } = harness({
      latest: 100n,
      cursor: 90n,
      rows: [confirmedRow(pendingSeed, original)],
      events: [event95],
    });

    const summary = await service.execute();

    expect(summary).toMatchObject({ conflictingEvents: 1, evidenceRefreshed: 0, eventsReplayed: 0 });
    expect(repository.row("acct_01")).toMatchObject({ transactionHash: hash("77"), blockNumber: 60n });
    expect(repository.writes).toEqual([]);
  });

  it("does not adopt a different transaction for a flagged row either", async () => {
    const original = { ...identityAt(60n), transactionHash: hash("77") };
    const { service, repository } = harness({
      latest: 100n,
      cursor: 90n,
      rows: [{ ...confirmedRow(pendingSeed, original), flaggedAt: NOW, flag: "event_missing" }],
      events: [event95],
    });

    const summary = await service.execute();

    expect(summary.conflictingEvents).toBe(1);
    expect(repository.row("acct_01")).toMatchObject({ transactionHash: hash("77"), flag: "event_missing" });
  });

  it("counts an event emitted for another wallet as a conflict, with no mismatch audit row", async () => {
    const { service, repository } = harness({
      latest: 100n,
      cursor: 90n,
      rows: [confirmedRow({ ...pendingSeed, walletAddress: "0xexpected" }, identityAt(60n))],
      events: [event95],
    });

    const summary = await service.execute();

    expect(summary.conflictingEvents).toBe(1);
    expect(repository.recordedMismatches).toEqual([]);
    expect(summary.addressMismatches).toEqual([]);
  });

  it("classifies against the row's new state, once, when another run confirmed it between the read and the write", async () => {
    const { service, repository } = harness({ latest: 100n, cursor: 90n, rows: [pendingSeed], events: [event95] });
    const find = vi.spyOn(repository, "findWalletRegistrationByCommitment");
    // The other run confirmed this very event.
    repository.beforeNextConfirm = () => {
      const row = repository.row("acct_01");
      row.registeredAt = new Date("2026-11-13T11:59:00.000Z");
      Object.assign(row, {
        transactionHash: defaultTransactionHash(95n),
        blockHash: defaultBlockHash(95n),
        blockNumber: 95n,
        logIndex: 0,
      });
    };

    const summary = await service.execute();

    expect(summary).toMatchObject({ registrationsConfirmed: 0, eventsReplayed: 1, conflictingEvents: 0 });
    expect(find).toHaveBeenCalledTimes(2);
    expect(repository.writesOf("confirm")).toHaveLength(0);
  });

  it("counts a conflict when the row another run confirmed holds a different event", async () => {
    const { service, repository } = harness({ latest: 100n, cursor: 90n, rows: [pendingSeed], events: [event95] });
    repository.beforeNextConfirm = () => {
      const row = repository.row("acct_01");
      row.registeredAt = new Date("2026-11-13T11:59:00.000Z");
      Object.assign(row, { transactionHash: hash("77"), blockHash: hash("78"), blockNumber: 60n, logIndex: 1 });
    };

    const summary = await service.execute();

    expect(summary).toMatchObject({ conflictingEvents: 1, eventsReplayed: 0 });
  });

  it("counts an event another row already backs as a conflict and carries on with the next event", async () => {
    // Account x already holds (transaction at block 50, log index 0); the first event is the same
    // identity for acct_01, the second event is a different log for acct_02.
    const { service, repository } = harness({
      latest: 100n,
      cursor: 10n,
      rows: [
        pendingSeed,
        { accountId: "acct_02", walletAddress: "0xdef", commitment: "0xc2" },
        confirmedRow({ accountId: "acct_x", walletAddress: "0x999", commitment: "0xc9" }, identityAt(50n)),
      ],
      events: [
        { blockNumber: 50n, wallet: "0xABC", commitment: "0xC1", logIndex: 0 },
        { blockNumber: 50n, wallet: "0xDEF", commitment: "0xC2", logIndex: 1 },
      ],
    });

    const summary = await service.execute();

    expect(summary).toMatchObject({ conflictingEvents: 1, registrationsConfirmed: 1 });
    expect(repository.row("acct_01").registeredAt).toBeNull();
    expect(repository.row("acct_02").registeredAt).not.toBeNull();
    expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(97n);
  });

  it("defers a refresh whose new identity another row still holds, and counts it", async () => {
    const { service, repository } = harness({
      latest: 100n,
      cursor: 90n,
      rows: [
        confirmedRow(pendingSeed, { ...identityAt(95n), blockHash: hash("99"), logIndex: 5 }),
        // After the reorganization acct_01's event takes log index 0; acct_x's old identity is that.
        confirmedRow({ accountId: "acct_x", walletAddress: "0x999", commitment: "0xc9" }, { ...identityAt(95n), blockHash: hash("98") }),
      ],
      events: [event95],
    });

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceRefreshDeferred: 1, evidenceRefreshed: 0 });
    expect(repository.row("acct_01")).toMatchObject({ blockHash: hash("99"), logIndex: 5 });
    // The cursor goes back to the block before the event, so the next run reads it again and retries.
    expect(summary.cursorRewoundTo).toBe("94");
    expect(repository.cursorWrites).toEqual([94n]);
  });

  it("does not hold the cursor back for a deferred refresh once the event's block is as deep as the final depth", async () => {
    const depth = WALLET_REGISTRY_EVIDENCE_FINAL_DEPTH;
    const rows = () => [
      confirmedRow(pendingSeed, { ...identityAt(95n), blockHash: hash("99"), logIndex: 5 }),
      confirmedRow({ accountId: "acct_x", walletAddress: "0x999", commitment: "0xc9" }, { ...identityAt(95n), blockHash: hash("98") }),
    ];
    // A row that never moves (its own event is gone) must not stall the watcher for good.
    const justInside = harness({ latest: 95n + depth - 1n, cursor: 100n, rows: rows(), events: [event95] });
    const atDepth = harness({ latest: 95n + depth, cursor: 100n, rows: rows(), events: [event95] });

    const inside = await justInside.service.execute();
    const deep = await atDepth.service.execute();

    expect(inside).toMatchObject({ evidenceRefreshDeferred: 1, cursorRewoundTo: "94" });
    expect(deep).toMatchObject({ evidenceRefreshDeferred: 1, cursorRewoundTo: null });
    expect(await atDepth.repository.getLastProcessedWalletRegistryBlock()).toBe(95n + depth - 3n);
  });

  it("does not rewind for a refresh another run already did", async () => {
    const { service, repository } = harness({
      latest: 100n,
      cursor: 90n,
      rows: [confirmedRow(pendingSeed, { ...identityAt(95n), blockHash: hash("99"), logIndex: 5 })],
      events: [event95],
    });
    // The row changes between the read and the compare-and-set write.
    const replace = vi.spyOn(repository, "replaceWalletRegistrationEvidence").mockResolvedValue("stale");

    const summary = await service.execute();

    expect(replace).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ evidenceRefreshed: 0, evidenceRefreshDeferred: 0, cursorRewoundTo: null });
  });

  it("counts only events that belong to no row as unmatched", async () => {
    const { service } = harness({ latest: 100n, cursor: 90n, rows: [], events: [event95] });

    const summary = await service.execute();

    expect(summary).toMatchObject({ unmatchedEvents: 1, eventsReplayed: 0 });
  });
});

describe("ConfirmWalletRegistrationsService: re-checking recorded confirmations", () => {
  const rowAt = (blockNumber: bigint, accountId = "acct_01", commitment = COMMITMENT) =>
    confirmedRow({ accountId, walletAddress: WALLET, commitment }, identityAt(blockNumber));

  it("leaves a confirmation alone while its block is canonical and not yet deep enough to be final", async () => {
    const { service, repository, reader } = harness({ latest: 100n, cursor: 90n, rows: [rowAt(95n)] });

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceRechecked: 1, evidenceVerified: 0, evidenceFlagged: 0, evidenceRecheckErrors: 0, cursorRewoundTo: null });
    expect(reader.lookupCalls).toEqual([]);
    expect(repository.writes).toEqual([]);
  });

  it("marks a confirmation verified once its block is final, and does not look at it again", async () => {
    const { service, repository, reader } = harness({ latest: 2_000n, cursor: 1_990n, rows: [rowAt(50n)] });

    const first = await service.execute();
    const second = await service.execute();

    expect(first.evidenceVerified).toBe(1);
    expect(repository.row("acct_01").verifiedAt).toEqual(NOW);
    expect(second.evidenceRechecked).toBe(0);
    expect(reader.hashCalls).toEqual([50n]);
  });

  it("verifies at exactly the final depth and not one block before", async () => {
    const depth = WALLET_REGISTRY_EVIDENCE_FINAL_DEPTH;
    const before = harness({ latest: 100n + depth - 1n, cursor: 100n + depth - 10n, rows: [rowAt(100n)] });
    const at = harness({ latest: 100n + depth, cursor: 100n + depth - 10n, rows: [rowAt(100n)] });

    expect((await before.service.execute()).evidenceVerified).toBe(0);
    expect((await at.service.execute()).evidenceVerified).toBe(1);
  });

  it("refreshes the evidence and rewinds the cursor when the transaction was mined again in another block", async () => {
    const { service, repository, reader } = harness({ latest: 100n, cursor: 90n, rows: [rowAt(95n)] });
    reader.canonicalHashes.set(95n, hash("cc"));
    reader.lookups.set(defaultTransactionHash(95n), {
      kind: "found",
      evidence: { transactionHash: defaultTransactionHash(95n), blockHash: hash("dd"), blockNumber: 96n, logIndex: 2 },
      chainTimestamp: NOW,
    });

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceRefreshed: 1, evidenceFlagged: 0, cursorRewoundTo: "94" });
    expect(repository.row("acct_01")).toMatchObject({ blockHash: hash("dd"), blockNumber: 96n, logIndex: 2 });
    expect(repository.cursorWrites).toEqual([94n]);
  });

  it("waits, but still rewinds, when the transaction was mined again too recently to record", async () => {
    const { service, repository, reader } = harness({ latest: 100n, cursor: 90n, rows: [rowAt(95n)] });
    reader.canonicalHashes.set(95n, hash("cc"));
    reader.lookups.set(defaultTransactionHash(95n), {
      kind: "found",
      evidence: { transactionHash: defaultTransactionHash(95n), blockHash: hash("dd"), blockNumber: 99n, logIndex: 2 },
      chainTimestamp: NOW,
    });

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceRefreshed: 0, cursorRewoundTo: "94" });
    expect(repository.row("acct_01").blockHash).toBe(defaultBlockHash(95n));
  });

  it.each([
    ["transaction_not_found", "transaction_missing"],
    ["transaction_reverted", "transaction_reverted"],
    ["event_not_found", "event_missing"],
  ] as const)("flags a confirmation as %s without reverting registered_at, and rewinds the cursor", async (kind, flag) => {
    const row = rowAt(95n);
    const { service, repository, reader } = harness({ latest: 100n, cursor: 90n, rows: [row] });
    reader.canonicalHashes.set(95n, hash("cc"));
    reader.lookups.set(defaultTransactionHash(95n), { kind });

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceFlagged: 1, cursorRewoundTo: "94" });
    expect(repository.row("acct_01")).toMatchObject({ flag, flaggedAt: NOW, registeredAt: row.registeredAt });
    expect(reader.lookupCalls[0]).toEqual({ transactionHash: defaultTransactionHash(95n), walletAddress: WALLET, commitment: COMMITMENT });
  });

  it("does not list a flagged row again, so a second run neither flags nor rewinds", async () => {
    const { service, repository, reader } = harness({ latest: 100n, cursor: 90n, rows: [rowAt(95n)] });
    reader.canonicalHashes.set(95n, hash("cc"));
    reader.lookups.set(defaultTransactionHash(95n), { kind: "transaction_not_found" });

    const first = await service.execute();
    const second = await service.execute();

    expect(first.cursorRewoundTo).toBe("94");
    expect(second).toMatchObject({ evidenceRechecked: 0, evidenceFlagged: 0, cursorRewoundTo: null });
    expect(repository.writesOf("flag")).toHaveLength(1);
    expect(repository.cursorWrites).toEqual([94n, 97n]);
  });

  it("flags a deep mismatch for staff but does not rewind the cursor that far", async () => {
    const { service, reader } = harness({ latest: 2_000n, cursor: 1_990n, rows: [rowAt(100n)] });
    reader.canonicalHashes.set(100n, hash("cc"));
    reader.lookups.set(defaultTransactionHash(100n), { kind: "transaction_not_found" });

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceFlagged: 1, cursorRewoundTo: null });
  });

  it("does not flag or rewind when the receipt sits in the very block the node says is not canonical", async () => {
    const { service, repository, reader } = harness({ latest: 100n, cursor: 90n, rows: [rowAt(95n)] });
    reader.canonicalHashes.set(95n, hash("cc"));
    reader.lookups.set(defaultTransactionHash(95n), {
      kind: "found",
      evidence: { ...identityAt(95n) },
      chainTimestamp: NOW,
    });

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceRecheckErrors: 1, evidenceFlagged: 0, evidenceRefreshed: 0, cursorRewoundTo: null });
    expect(repository.row("acct_01").flag).toBeNull();
  });

  it("gives no verdict when the node does not have the block", async () => {
    const { service, repository, reader } = harness({ latest: 100n, cursor: 90n, rows: [rowAt(95n)] });
    reader.canonicalHashes.set(95n, null);

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceRecheckErrors: 1, evidenceFlagged: 0, cursorRewoundTo: null });
    expect(reader.lookupCalls).toEqual([]);
    expect(repository.writes).toEqual([]);
  });

  it("carries on with the other rows and the cursor write when one row's check throws", async () => {
    const { service, repository, reader } = harness({
      latest: 2_000n,
      cursor: 1_990n,
      rows: [rowAt(50n, "acct_01", "0xc1"), rowAt(60n, "acct_02", "0xc2")],
    });
    reader.canonicalHashes.set(50n, new Error("rpc down at https://secret.example/rpc?key=abc"));

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceRechecked: 2, evidenceRecheckErrors: 1, evidenceVerified: 1 });
    expect(repository.row("acct_02").verifiedAt).toEqual(NOW);
    expect(repository.cursorWrites).toEqual([1_997n]);
    // Nothing from the thrown error reaches the summary the worker logs.
    expect(JSON.stringify(summary)).not.toContain("secret.example");
  });

  it("writes the lowest rewind as the cursor, once", async () => {
    const { service, repository, reader } = harness({
      latest: 100n,
      cursor: 90n,
      rows: [rowAt(95n, "acct_01", "0xc1"), rowAt(93n, "acct_02", "0xc2")],
    });
    for (const block of [95n, 93n]) {
      reader.canonicalHashes.set(block, hash("cc"));
      reader.lookups.set(defaultTransactionHash(block), { kind: "transaction_not_found" });
    }

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceFlagged: 2, cursorRewoundTo: "92" });
    expect(repository.cursorWrites).toEqual([92n]);
  });

  it("re-checks at most fifty rows per run, oldest block first", async () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      rowAt(BigInt(10 + index), `acct_${String(index).padStart(2, "0")}`, `0xc${index}`),
    );
    const { service, reader } = harness({ latest: 2_000n, cursor: 1_990n, rows });

    const summary = await service.execute();

    expect(summary.evidenceRechecked).toBe(50);
    expect(reader.hashCalls[0]).toBe(10n);
    expect(reader.hashCalls[49]).toBe(59n);
  });

  it("does not touch pending rows or rows without a recorded block", async () => {
    const { service, reader } = harness({
      latest: 100n,
      cursor: 90n,
      rows: [pendingSeed, { accountId: "acct_02", walletAddress: "0xdef", commitment: "0xc2", registeredAt: NOW }],
    });

    const summary = await service.execute();

    expect(summary.evidenceRechecked).toBe(0);
    expect(reader.hashCalls).toEqual([]);
  });

  it("does not run the re-check when the cursor is already ahead of the safe head", async () => {
    const { service, reader } = harness({ latest: 100n, cursor: 200n, rows: [rowAt(95n)] });

    const summary = await service.execute();

    expect(summary.evidenceRechecked).toBe(0);
    expect(reader.hashCalls).toEqual([]);
  });
});

describe("ConfirmWalletRegistrationsService: a bundled transaction mined again with shifted log indexes", () => {
  const BUNDLE_TX = hash("bb");
  const OLD_BLOCK_HASH = hash("a0");
  const NEW_BLOCK_HASH = hash("a1");
  const NEW_BLOCK = 587n;
  const seeds = ["a", "b", "c", "d"].map((letter, index) => ({
    accountId: `acct_${letter}`,
    walletAddress: `0x${letter}`,
    commitment: `0xc${letter}`,
    index,
  }));
  // Four registrations of one transaction at log indexes 3, 5, 7, 9; mined again they sit at 5, 7, 9, 11, so
  // each one's new identity is the old identity of the next row until that row has moved too.
  const oldIdentity = (index: number): WalletRegistrationEvidence => ({
    transactionHash: BUNDLE_TX,
    blockHash: OLD_BLOCK_HASH,
    blockNumber: 500n,
    logIndex: 3 + index * 2,
  });
  const reminedEvents = (): FakeEvent[] =>
    seeds.map((seed) => ({
      blockNumber: NEW_BLOCK,
      wallet: seed.walletAddress,
      commitment: seed.commitment,
      transactionHash: BUNDLE_TX,
      blockHash: NEW_BLOCK_HASH,
      logIndex: 5 + seed.index * 2,
    }));

  function bundle(flagged: boolean) {
    const options = { latestBlock: 593n, events: reminedEvents() };
    const { chain } = makeFakeChain(options);
    const repository = new FakeWalletRegistrationRepository(
      seeds.map(({ index, ...seed }) => {
        const row = confirmedRow(seed, oldIdentity(index));
        return flagged ? { ...row, flaggedAt: NOW, flag: "transaction_missing" as const } : row;
      }),
      560n,
    );
    const reader = new FakeEvidenceReader();
    // The old block is gone from the chain; the transaction is in the new one.
    reader.canonicalHashes.set(500n, hash("ee"));
    reader.canonicalHashes.set(NEW_BLOCK, NEW_BLOCK_HASH);
    for (const seed of seeds) {
      reader.lookups.set(`${BUNDLE_TX}:${seed.commitment}`, {
        kind: "found",
        evidence: { ...oldIdentity(seed.index), blockHash: NEW_BLOCK_HASH, blockNumber: NEW_BLOCK, logIndex: 5 + seed.index * 2 },
        chainTimestamp: NOW,
      });
    }
    const service = new ConfirmWalletRegistrationsService(repository, chain as never, () => NOW, undefined, reader);
    // One run a minute, 30 blocks a minute.
    const advance = () => {
      options.latestBlock += 30n;
    };
    return { service, repository, advance };
  }

  const logIndexes = (repository: FakeWalletRegistrationRepository) =>
    seeds.map((seed) => repository.row(seed.accountId).logIndex);

  it("brings flagged rows to the new identities over the next runs and then stops rewinding", async () => {
    const { service, repository, advance } = bundle(true);
    const summaries = [];
    for (let run = 0; run < 6; run += 1) {
      summaries.push(await service.execute());
      advance();
    }

    // Each run moves the row at the end of the chain of collisions; the rewind is what brings the next run back.
    expect(summaries.map((summary) => summary.evidenceRefreshed)).toEqual([1, 1, 1, 1, 0, 0]);
    expect(summaries.map((summary) => summary.evidenceRefreshDeferred)).toEqual([3, 2, 1, 0, 0, 0]);
    expect(summaries.map((summary) => summary.cursorRewoundTo)).toEqual(["586", "586", "586", null, null, null]);
    expect(logIndexes(repository)).toEqual([5, 7, 9, 11]);
    for (const seed of seeds) {
      expect(repository.row(seed.accountId)).toMatchObject({ blockHash: NEW_BLOCK_HASH, blockNumber: NEW_BLOCK, flag: null, flaggedAt: null });
    }
    expect(repository.writesOf("replace:refreshed")).toHaveLength(4);
    expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(593n + 30n * 5n - 3n);
  });

  it("converges the same way for rows that were never flagged", async () => {
    const { service, repository, advance } = bundle(false);
    const summaries = [];
    for (let run = 0; run < 6; run += 1) {
      summaries.push(await service.execute());
      advance();
    }

    expect(logIndexes(repository)).toEqual([5, 7, 9, 11]);
    for (const seed of seeds) {
      expect(repository.row(seed.accountId)).toMatchObject({ blockHash: NEW_BLOCK_HASH, flag: null });
    }
    expect(summaries.at(-1)).toMatchObject({ evidenceRefreshDeferred: 0, cursorRewoundTo: null });
  });
});

describe("ConfirmWalletRegistrationsService: the cursor and the row changes of the re-check", () => {
  const rowAt = (blockNumber: bigint, accountId = "acct_01", commitment = COMMITMENT) =>
    confirmedRow({ accountId, walletAddress: WALLET, commitment }, identityAt(blockNumber));
  const reorganized = (reader: FakeEvidenceReader, block = 95n) => {
    reader.canonicalHashes.set(block, hash("cc"));
  };

  it("leaves the row unflagged when the cursor write fails, so the next run flags it and rewinds", async () => {
    const { service, repository, reader } = harness({ latest: 100n, cursor: 90n, rows: [rowAt(95n)] });
    reorganized(reader);
    reader.lookups.set(defaultTransactionHash(95n), { kind: "transaction_not_found" });
    repository.failSetCursor = true;

    await expect(service.execute()).rejects.toThrow("cursor write failed");

    // A flagged row is no longer a re-check candidate: flagging first would lose the rewind for good.
    expect(repository.row("acct_01")).toMatchObject({ flag: null, flaggedAt: null });
    expect(repository.writes).toEqual([]);

    repository.failSetCursor = false;
    const rerun = await service.execute();

    expect(rerun).toMatchObject({ evidenceRechecked: 1, evidenceFlagged: 1, cursorRewoundTo: "94" });
    expect(repository.row("acct_01").flag).toBe("transaction_missing");
    expect(repository.cursorWrites).toEqual([94n]);
  });

  it("leaves the row on its old evidence when the cursor write fails before a refresh", async () => {
    const { service, repository, reader } = harness({ latest: 100n, cursor: 90n, rows: [rowAt(95n)] });
    reorganized(reader);
    reader.lookups.set(defaultTransactionHash(95n), {
      kind: "found",
      evidence: { transactionHash: defaultTransactionHash(95n), blockHash: hash("dd"), blockNumber: 96n, logIndex: 2 },
      chainTimestamp: NOW,
    });
    repository.failSetCursor = true;

    await expect(service.execute()).rejects.toThrow("cursor write failed");

    expect(repository.row("acct_01")).toMatchObject({ blockHash: defaultBlockHash(95n), logIndex: 0 });
    repository.failSetCursor = false;
    expect(await service.execute()).toMatchObject({ evidenceRefreshed: 1, cursorRewoundTo: "94" });
  });

  it("has written the rewound cursor before the first flag or refresh of the run", async () => {
    const { service, repository, reader } = harness({
      latest: 100n,
      cursor: 90n,
      rows: [rowAt(95n, "acct_01", "0xc1"), rowAt(93n, "acct_02", "0xc2")],
    });
    for (const block of [95n, 93n]) reorganized(reader, block);
    reader.lookups.set(defaultTransactionHash(93n), { kind: "transaction_not_found" });
    reader.lookups.set(defaultTransactionHash(95n), {
      kind: "found",
      evidence: { transactionHash: defaultTransactionHash(95n), blockHash: hash("dd"), blockNumber: 96n, logIndex: 2 },
      chainTimestamp: NOW,
    });
    const cursorWritesSeenByRowWrites: number[] = [];
    for (const method of ["flagWalletRegistrationEvidence", "replaceWalletRegistrationEvidence"] as const) {
      const original = repository[method].bind(repository) as (input: never) => Promise<unknown>;
      vi.spyOn(repository, method).mockImplementation((async (input: never) => {
        cursorWritesSeenByRowWrites.push(repository.cursorWrites.length);
        return original(input);
      }) as never);
    }

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceFlagged: 1, evidenceRefreshed: 1, cursorRewoundTo: "92" });
    expect(cursorWritesSeenByRowWrites).toEqual([1, 1]);
    expect(repository.cursorWrites).toEqual([92n]);
  });

  it("keeps the rewound cursor when writing the flag fails, and counts the error", async () => {
    const { service, repository, reader } = harness({ latest: 100n, cursor: 90n, rows: [rowAt(95n)] });
    reorganized(reader);
    reader.lookups.set(defaultTransactionHash(95n), { kind: "transaction_not_found" });
    vi.spyOn(repository, "flagWalletRegistrationEvidence").mockRejectedValue(new Error("db down at postgres://secret"));

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceFlagged: 0, evidenceRecheckErrors: 1, cursorRewoundTo: "94" });
    expect(repository.cursorWrites).toEqual([94n]);
    expect(JSON.stringify(summary)).not.toContain("secret");
    // The row is still a candidate, so the next run flags it.
    vi.restoreAllMocks();
    expect(await service.execute()).toMatchObject({ evidenceFlagged: 1, cursorRewoundTo: "94" });
  });

  it("does not let a failing row stop the others from being flagged or refreshed", async () => {
    const { service, repository, reader } = harness({
      latest: 100n,
      cursor: 90n,
      rows: [rowAt(95n, "acct_01", "0xc1"), rowAt(93n, "acct_02", "0xc2")],
    });
    for (const block of [95n, 93n]) reorganized(reader, block);
    for (const block of [95n, 93n]) reader.lookups.set(defaultTransactionHash(block), { kind: "transaction_not_found" });
    const original = repository.flagWalletRegistrationEvidence.bind(repository);
    vi.spyOn(repository, "flagWalletRegistrationEvidence").mockImplementation(async (input) => {
      if (input.accountId === "acct_02") throw new Error("db down");
      return original(input);
    });

    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceFlagged: 1, evidenceRecheckErrors: 1, cursorRewoundTo: "92" });
    expect(repository.row("acct_01").flag).toBe("transaction_missing");
    expect(repository.row("acct_02").flag).toBeNull();
  });
});

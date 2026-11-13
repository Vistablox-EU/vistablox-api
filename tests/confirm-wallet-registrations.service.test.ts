import { describe, expect, it, vi } from "vitest";

import { ConfirmWalletRegistrationsService } from "../src/modules/settlement/application/confirm-wallet-registrations.service.js";
import { walletRegistrationAddressMismatchEventKey } from "../src/modules/settlement/repository/prisma-settlement.repository.js";
import type {
  PendingWalletRegistration,
  PivPendingEscrowResolution,
  SettlementRepository,
  WalletRegistrationAddressMismatchInput,
} from "../src/modules/settlement/repository/settlement.repository.js";

const MAX_BLOCK_RANGE_PER_RUN = 2000n;
const CONFIRMATION_DEPTH = 3n;

interface FakeEvent {
  blockNumber: bigint;
  wallet: string;
  commitment: string;
  // Leaves blockNumber out of the log the chain returns (it is still used to
  // decide whether the log falls in the queried range).
  omitBlockNumber?: boolean;
}

// Realistic values: a 40-hex address and a 64-hex commitment. The masks and the
// "no full value in a log line" checks below only mean something on these.
const STORED_WALLET = "0xAbCdEf0123456789aBcDeF0123456789abcdef01";
const ATTACKER_WALLET = "0x9999999999aaaaaaaaaa0000000000bbbbbbbbbb";
const SECOND_ATTACKER_WALLET = "0x7777777777cccccccccc1111111111dddddddddd";
const COMMITMENT = `0x${"c0de".repeat(16)}`;
const FULL_HEX_RUN = /0x[0-9a-fA-F]{12,}/;

function makeFakeChain(options: { latestBlock: bigint; events: FakeEvent[]; failGetEvents?: boolean }) {
  const getEventsCalls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  return {
    chain: {
      publicClient: {
        getBlockNumber: vi.fn(async () => options.latestBlock),
      },
      walletRegistry: {
        getEvents: {
          WalletRegistered: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
            getEventsCalls.push({ fromBlock, toBlock });
            if (options.failGetEvents) throw new Error("RPC log query failed");
            return options.events
              .filter((event) => event.blockNumber >= fromBlock && event.blockNumber <= toBlock)
              .map((event) => ({
                args: { wallet: event.wallet, commitment: event.commitment },
                ...(event.omitBlockNumber === true ? {} : { blockNumber: event.blockNumber }),
              }));
          }),
        },
      },
    },
    getEventsCalls,
  };
}

// A small in-memory model of the two tables this job reconciles against
// (wallet_registrations and the settings cursor row), not just canned
// return values -- so a commitment match is genuinely looked up and a
// confirm genuinely makes a later lookup for the same commitment fail,
// mirroring the real repository's registered_at IS NULL filter.
class FakeSettlementRepository implements SettlementRepository {
  public readonly confirmedAccountIds: string[] = [];
  public readonly recordedMismatches: WalletRegistrationAddressMismatchInput[] = [];
  private readonly overdueCount: number;
  public overdueCutoff: Date | undefined;
  private readonly byCommitment: Map<string, PendingWalletRegistration>;
  private readonly confirmed = new Set<string>();
  private readonly mismatchKeys = new Set<string>();
  private cursor: bigint | null;

  public constructor(
    pending: Array<PendingWalletRegistration & { commitment: string }>,
    initialCursor: bigint | null = null,
    overdueCount = 0,
  ) {
    this.byCommitment = new Map(pending.map((row) => [row.commitment.toLowerCase(), row]));
    this.cursor = initialCursor;
    this.overdueCount = overdueCount;
  }

  public async findPendingWalletRegistrationByCommitment(
    commitment: string,
  ): Promise<PendingWalletRegistration | null> {
    const match = this.byCommitment.get(commitment.toLowerCase());
    if (match === undefined || this.confirmed.has(match.accountId)) return null;
    return { accountId: match.accountId, walletAddress: match.walletAddress };
  }

  public async confirmWalletRegistration(accountId: string): Promise<void> {
    this.confirmed.add(accountId);
    this.confirmedAccountIds.push(accountId);
  }

  public async countPendingWalletRegistrationsBefore(cutoff: Date): Promise<number> {
    this.overdueCutoff = cutoff;
    return this.overdueCount;
  }

  // The real repository claims audit_log.event_key with a conflict-do-nothing
  // insert, so the same (account, commitment, sender) is stored once and every
  // later attempt reports created: false. The same key function is used here
  // so this fake cannot drift from what the database sees.
  public async recordWalletRegistrationAddressMismatch(
    input: WalletRegistrationAddressMismatchInput,
  ): Promise<{ created: boolean }> {
    const key = walletRegistrationAddressMismatchEventKey(input);
    if (this.mismatchKeys.has(key)) return { created: false };
    this.mismatchKeys.add(key);
    this.recordedMismatches.push(input);
    return { created: true };
  }

  public async getLastProcessedWalletRegistryBlock(): Promise<bigint | null> {
    return this.cursor;
  }

  public async setLastProcessedWalletRegistryBlock(block: bigint): Promise<void> {
    this.cursor = block;
  }

  // Unused by this suite -- escrow finalize-and-mint only (see
  // finalize-ipo-escrow-campaigns.service.test.ts for that).
  public async findPivsWithPassedIpoDeadline(): Promise<PivPendingEscrowResolution[]> {
    return [];
  }

  public async resolveAccountIdForWallet(): Promise<string | null> {
    return null;
  }

  public async hasPosition(): Promise<boolean> {
    return false;
  }

  public async findEscrowMintIntent(): Promise<null> {
    return null;
  }

  public async createEscrowMintIntent(): Promise<never> {
    throw new Error("unused");
  }

  public async restartEscrowMintAttempt(): Promise<boolean> {
    return false;
  }

  public async recordEscrowMintSent(): Promise<void> {}

  public async recordEscrowMintedPosition(): Promise<{ positionId: string }> {
    return { positionId: "unused" };
  }
}

describe("ConfirmWalletRegistrationsService", () => {
  it("confirms a pending registration when the event's commitment and wallet both match", async () => {
    const { chain } = makeFakeChain({
      latestBlock: 100n,
      events: [{ blockNumber: 50n, wallet: "0xABC", commitment: "0xC1" }],
    });
    const repository = new FakeSettlementRepository(
      [{ accountId: "acct_01", walletAddress: "0xabc", commitment: "0xc1" }],
      10n,
    );
    const service = new ConfirmWalletRegistrationsService(repository, chain as never, () => new Date());

    const summary = await service.execute();

    expect(summary).toMatchObject({
      eventsFound: 1,
      registrationsConfirmed: 1,
      unmatchedEvents: 0,
      addressMismatches: [],
    });
    expect(repository.confirmedAccountIds).toEqual(["acct_01"]);
  });

  it("reports registrations pending longer than the operational threshold", async () => {
    const { chain } = makeFakeChain({ latestBlock: 100n, events: [] });
    const repository = new FakeSettlementRepository([], 10n, 2);
    const service = new ConfirmWalletRegistrationsService(repository, chain as never, () => new Date("2026-09-16T10:00:00Z"));

    const summary = await service.execute();

    expect(summary.pendingRegistrationsOverdue).toBe(2);
  });

  it("uses the configured overdue threshold and reports it in the summary", async () => {
    const { chain } = makeFakeChain({ latestBlock: 100n, events: [] });
    const repository = new FakeSettlementRepository([], 10n, 1);
    const now = new Date("2026-09-16T10:00:00Z");
    const service = new ConfirmWalletRegistrationsService(repository, chain as never, () => now, 15 * 60_000);

    const summary = await service.execute();

    expect(repository.overdueCutoff?.toISOString()).toBe("2026-09-16T09:45:00.000Z");
    expect(summary.pendingWarnAfterMinutes).toBe(15);
  });

  it("starts watching from the latest confirmed block, not the mutable chain head, on the very first run", async () => {
    const { chain, getEventsCalls } = makeFakeChain({ latestBlock: 500n, events: [] });
    const repository = new FakeSettlementRepository([], null);
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute();

    expect(getEventsCalls).toEqual([{ fromBlock: 500n - CONFIRMATION_DEPTH, toBlock: 500n - CONFIRMATION_DEPTH }]);
    expect(summary.fromBlock).toBe("497");
    expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(497n);
  });

  it("counts an event with no matching pending registration as unmatched, without confirming anything", async () => {
    const { chain } = makeFakeChain({
      latestBlock: 20n,
      events: [{ blockNumber: 15n, wallet: "0xABC", commitment: "0xdeadbeef" }],
    });
    const repository = new FakeSettlementRepository([], 10n);
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute();

    expect(summary).toMatchObject({ eventsFound: 1, registrationsConfirmed: 0, unmatchedEvents: 1 });
    expect(repository.confirmedAccountIds).toEqual([]);
  });

  it("flags an address mismatch instead of confirming when the on-chain sender doesn't match the stored wallet", async () => {
    const { chain } = makeFakeChain({
      latestBlock: 20n,
      events: [{ blockNumber: 15n, wallet: ATTACKER_WALLET, commitment: COMMITMENT }],
    });
    const repository = new FakeSettlementRepository(
      [{ accountId: "acct_01", walletAddress: STORED_WALLET, commitment: COMMITMENT }],
      10n,
    );
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute();

    expect(summary.registrationsConfirmed).toBe(0);
    expect(summary.addressMismatches).toEqual([
      {
        accountId: "acct_01",
        commitmentMasked: "0xc0de...c0de",
        storedWalletMasked: "0xabcd...ef01",
        onChainSenderMasked: "0x9999...bbbb",
      },
    ]);
    expect(summary.addressMismatchesRepeated).toBe(0);
    expect(repository.confirmedAccountIds).toEqual([]);
    // Not just the in-memory summary the worker logs -- a durable record too,
    // so this survives past the log line scrolling away. The audit row is the
    // forensic evidence: it keeps the FULL values the summary masks.
    expect(repository.recordedMismatches).toEqual([
      {
        accountId: "acct_01",
        commitment: COMMITMENT,
        storedWalletAddress: STORED_WALLET,
        onChainSender: ATTACKER_WALLET,
        detectedAt: expect.any(Date),
      },
    ]);
  });

  it("never puts a full address or commitment into the summary the worker logs", async () => {
    const { chain } = makeFakeChain({
      latestBlock: 20n,
      events: [
        { blockNumber: 15n, wallet: ATTACKER_WALLET, commitment: COMMITMENT },
        { blockNumber: 16n, wallet: ATTACKER_WALLET, commitment: `0x${"d1ce".repeat(16)}` },
      ],
    });
    const repository = new FakeSettlementRepository(
      [{ accountId: "acct_01", walletAddress: STORED_WALLET, commitment: COMMITMENT }],
      10n,
    );
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute();

    // One mismatch signal and one unmatched event: both paths are covered.
    expect(summary.addressMismatches).toHaveLength(1);
    expect(summary.unmatchedEvents).toBe(1);
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toMatch(FULL_HEX_RUN);
    for (const secret of [STORED_WALLET, ATTACKER_WALLET, COMMITMENT]) {
      expect(serialised.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it("raises one signal when the same mismatching event is read twice in one run", async () => {
    const event = { blockNumber: 15n, wallet: ATTACKER_WALLET, commitment: COMMITMENT };
    const { chain } = makeFakeChain({ latestBlock: 20n, events: [event, event] });
    const repository = new FakeSettlementRepository(
      [{ accountId: "acct_01", walletAddress: STORED_WALLET, commitment: COMMITMENT }],
      10n,
    );
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute();

    expect(summary.eventsFound).toBe(2);
    expect(summary.addressMismatches).toHaveLength(1);
    expect(summary.addressMismatchesRepeated).toBe(1);
    expect(repository.recordedMismatches).toHaveLength(1);
  });

  it("does not raise the mismatch again when the next run's overlap rescan reads the same event", async () => {
    const { chain } = makeFakeChain({
      latestBlock: 20n,
      events: [{ blockNumber: 15n, wallet: ATTACKER_WALLET, commitment: COMMITMENT }],
    });
    const repository = new FakeSettlementRepository(
      [{ accountId: "acct_01", walletAddress: STORED_WALLET, commitment: COMMITMENT }],
      10n,
    );
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const first = await service.execute();
    const second = await service.execute();

    expect(first.addressMismatches).toHaveLength(1);
    // The cursor is now 17 and the overlap re-reads block 15.
    expect(second.eventsFound).toBe(1);
    expect(second.addressMismatches).toEqual([]);
    expect(second.addressMismatchesRepeated).toBe(1);
    expect(repository.recordedMismatches).toHaveLength(1);
  });

  it("treats a mismatch from a different sender for the same commitment as a new signal", async () => {
    const { chain } = makeFakeChain({
      latestBlock: 20n,
      events: [
        { blockNumber: 15n, wallet: ATTACKER_WALLET, commitment: COMMITMENT },
        { blockNumber: 16n, wallet: SECOND_ATTACKER_WALLET, commitment: COMMITMENT },
        // The same first sender, spelled in another case, is still the first signal.
        { blockNumber: 17n, wallet: ATTACKER_WALLET.toUpperCase().replace("0X", "0x"), commitment: COMMITMENT },
      ],
    });
    const repository = new FakeSettlementRepository(
      [{ accountId: "acct_01", walletAddress: STORED_WALLET, commitment: COMMITMENT }],
      10n,
    );
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute();

    expect(summary.addressMismatches.map((signal) => signal.onChainSenderMasked)).toEqual([
      "0x9999...bbbb",
      "0x7777...dddd",
    ]);
    expect(summary.addressMismatchesRepeated).toBe(1);
    expect(repository.recordedMismatches.map((row) => row.onChainSender)).toEqual([
      ATTACKER_WALLET,
      SECOND_ATTACKER_WALLET,
    ]);
  });

  it("caps the scanned range per run instead of scanning a large gap in one call", async () => {
    const { chain, getEventsCalls } = makeFakeChain({ latestBlock: 100_000n, events: [] });
    const repository = new FakeSettlementRepository([], 0n);
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute();

    const expectedToBlock = MAX_BLOCK_RANGE_PER_RUN;
    expect(getEventsCalls).toEqual([{ fromBlock: 0n, toBlock: expectedToBlock }]);
    expect(summary.toBlock).toBe(expectedToBlock.toString());
    expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(expectedToBlock);
  });

  it("rescans the recent overlap even when the cursor has caught up to the safe head", async () => {
    const { chain, getEventsCalls } = makeFakeChain({ latestBlock: 50n, events: [] });
    const repository = new FakeSettlementRepository([], 50n);
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute();

    expect(getEventsCalls).toEqual([{ fromBlock: 19n, toBlock: 47n }]);
    expect(summary.eventsFound).toBe(0);
  });

  it("rescans the cursor overlap so an event missed during RPC indexing is recovered", async () => {
    const { chain, getEventsCalls } = makeFakeChain({
      latestBlock: 120n,
      events: [{ blockNumber: 95n, wallet: "0xABC", commitment: "0xc1" }],
    });
    const repository = new FakeSettlementRepository(
      [{ accountId: "acct_01", walletAddress: "0xabc", commitment: "0xc1" }],
      100n,
    );
    const service = new ConfirmWalletRegistrationsService(repository, chain as never, () => new Date());

    await service.execute();

    expect(getEventsCalls[0]!.fromBlock).toBe(69n);
    expect(getEventsCalls[0]!.toBlock).toBe(117n);
    expect(repository.confirmedAccountIds).toEqual(["acct_01"]);
  });

  it("does not advance the cursor when the RPC log query fails", async () => {
    const { chain } = makeFakeChain({ latestBlock: 120n, events: [], failGetEvents: true });
    const repository = new FakeSettlementRepository([], 100n);
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    await expect(service.execute()).rejects.toThrow("RPC log query failed");
    expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(100n);
  });

  it("is idempotent when an overlapping range returns the same event twice", async () => {
    const event = { blockNumber: 95n, wallet: "0xABC", commitment: "0xc1" };
    const { chain } = makeFakeChain({ latestBlock: 120n, events: [event, event] });
    const repository = new FakeSettlementRepository(
      [{ accountId: "acct_01", walletAddress: "0xabc", commitment: "0xc1" }],
      100n,
    );
    const service = new ConfirmWalletRegistrationsService(repository, chain as never, () => new Date());

    const summary = await service.execute();

    expect(summary.eventsFound).toBe(2);
    expect(summary.registrationsConfirmed).toBe(1);
    expect(repository.confirmedAccountIds).toEqual(["acct_01"]);
  });

  describe("newUnmatchedEvents", () => {
    // unmatchedEvents counts every event with no PENDING row, including a
    // registration confirmed one minute ago that the overlap rescan reads
    // again. newUnmatchedEvents is the part that is news: an event in a block
    // past the cursor an earlier completed run reached.
    const UNKNOWN_COMMITMENT = `0x${"f00d".repeat(16)}`;

    it("does not count the overlap replay of a registration that was just confirmed", async () => {
      const { chain } = makeFakeChain({
        latestBlock: 20n,
        events: [{ blockNumber: 15n, wallet: STORED_WALLET, commitment: COMMITMENT }],
      });
      const repository = new FakeSettlementRepository(
        [{ accountId: "acct_01", walletAddress: STORED_WALLET, commitment: COMMITMENT }],
        10n,
      );
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const first = await service.execute();
      const second = await service.execute();

      expect(first).toMatchObject({ registrationsConfirmed: 1, unmatchedEvents: 0, newUnmatchedEvents: 0 });
      // The cursor is 17 now; block 15 is replayed and the row is no longer pending.
      expect(second).toMatchObject({ eventsFound: 1, unmatchedEvents: 1, newUnmatchedEvents: 0 });
    });

    it("counts an unknown event in a block past the cursor, but not one at or before it", async () => {
      const { chain } = makeFakeChain({
        latestBlock: 100n,
        events: [
          { blockNumber: 49n, wallet: STORED_WALLET, commitment: UNKNOWN_COMMITMENT },
          { blockNumber: 50n, wallet: STORED_WALLET, commitment: UNKNOWN_COMMITMENT },
          { blockNumber: 51n, wallet: STORED_WALLET, commitment: UNKNOWN_COMMITMENT },
          { blockNumber: 90n, wallet: STORED_WALLET, commitment: UNKNOWN_COMMITMENT },
        ],
      });
      const repository = new FakeSettlementRepository([], 50n);
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const summary = await service.execute();

      expect(summary.unmatchedEvents).toBe(4);
      // Block 50 is exactly the cursor: a completed run already covered it.
      expect(summary.newUnmatchedEvents).toBe(2);
    });

    it("counts an event whose log carries no block number, because it cannot be shown to be a replay", async () => {
      const { chain } = makeFakeChain({
        latestBlock: 100n,
        events: [{ blockNumber: 40n, wallet: STORED_WALLET, commitment: UNKNOWN_COMMITMENT, omitBlockNumber: true }],
      });
      const repository = new FakeSettlementRepository([], 50n);
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const summary = await service.execute();

      expect(summary).toMatchObject({ unmatchedEvents: 1, newUnmatchedEvents: 1 });
    });

    it("counts every unmatched event on the first run, when there is no cursor to compare with", async () => {
      const { chain } = makeFakeChain({
        latestBlock: 500n,
        events: [{ blockNumber: 497n, wallet: STORED_WALLET, commitment: UNKNOWN_COMMITMENT }],
      });
      const repository = new FakeSettlementRepository([], null);
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const summary = await service.execute();

      expect(summary).toMatchObject({ unmatchedEvents: 1, newUnmatchedEvents: 1 });
    });
  });

  describe("safeHeadBlock", () => {
    it("reports the safe head the run worked against", async () => {
      const { chain } = makeFakeChain({ latestBlock: 120n, events: [] });
      const repository = new FakeSettlementRepository([], 100n);
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const summary = await service.execute();

      expect(summary.safeHeadBlock).toBe("117");
    });

    it("reports the real safe head, not this run's capped toBlock, when a long gap is being caught up", async () => {
      const { chain } = makeFakeChain({ latestBlock: 100_000n, events: [] });
      const repository = new FakeSettlementRepository([], 0n);
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const summary = await service.execute();

      expect(summary.toBlock).toBe("2000");
      expect(summary.safeHeadBlock).toBe("99997");
    });

    it("reports it on the early-return path where the cursor is ahead of the chain", async () => {
      const { chain, getEventsCalls } = makeFakeChain({ latestBlock: 50n, events: [] });
      const repository = new FakeSettlementRepository([], 100n);
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const summary = await service.execute();

      expect(getEventsCalls).toEqual([]);
      expect(summary.safeHeadBlock).toBe("47");
      expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(100n);
    });

    it("clamps to zero on a chain younger than the confirmation depth", async () => {
      const { chain } = makeFakeChain({ latestBlock: 1n, events: [] });
      const repository = new FakeSettlementRepository([], null);
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const summary = await service.execute();

      expect(summary.safeHeadBlock).toBe("0");
    });
  });
});

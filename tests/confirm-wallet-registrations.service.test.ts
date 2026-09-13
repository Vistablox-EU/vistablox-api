import { describe, expect, it, vi } from "vitest";

import { ConfirmWalletRegistrationsService } from "../src/modules/settlement/application/confirm-wallet-registrations.service.js";
import type {
  PendingWalletRegistration,
  PivPendingEscrowResolution,
  SettlementRepository,
  WalletRegistrationAddressMismatchInput,
} from "../src/modules/settlement/repository/settlement.repository.js";

const MAX_BLOCK_RANGE_PER_RUN = 2000n;

interface FakeEvent {
  blockNumber: bigint;
  wallet: string;
  commitment: string;
}

function makeFakeChain(options: { latestBlock: bigint; events: FakeEvent[] }) {
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
            return options.events
              .filter((event) => event.blockNumber >= fromBlock && event.blockNumber <= toBlock)
              .map((event) => ({ args: { wallet: event.wallet, commitment: event.commitment } }));
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
  private readonly byCommitment: Map<string, PendingWalletRegistration>;
  private readonly confirmed = new Set<string>();
  private cursor: bigint | null;

  public constructor(
    pending: Array<PendingWalletRegistration & { commitment: string }>,
    initialCursor: bigint | null = null,
  ) {
    this.byCommitment = new Map(pending.map((row) => [row.commitment.toLowerCase(), row]));
    this.cursor = initialCursor;
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

  public async recordWalletRegistrationAddressMismatch(
    input: WalletRegistrationAddressMismatchInput,
  ): Promise<void> {
    this.recordedMismatches.push(input);
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

  it("starts watching from the current block, not genesis, on the very first run", async () => {
    const { chain, getEventsCalls } = makeFakeChain({ latestBlock: 500n, events: [] });
    const repository = new FakeSettlementRepository([], null);
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute();

    expect(getEventsCalls).toEqual([{ fromBlock: 500n, toBlock: 500n }]);
    expect(summary.fromBlock).toBe("500");
    expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(500n);
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
      events: [{ blockNumber: 15n, wallet: "0xATTACKER", commitment: "0xc1" }],
    });
    const repository = new FakeSettlementRepository(
      [{ accountId: "acct_01", walletAddress: "0xEXPECTED", commitment: "0xc1" }],
      10n,
    );
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute();

    expect(summary.registrationsConfirmed).toBe(0);
    expect(summary.addressMismatches).toHaveLength(1);
    expect(summary.addressMismatches[0]).toContain("acct_01");
    expect(repository.confirmedAccountIds).toEqual([]);
    // Not just the in-memory summary string worker.ts logs -- a durable
    // record too, so this survives past the log line scrolling away.
    expect(repository.recordedMismatches).toEqual([
      {
        accountId: "acct_01",
        commitment: "0xc1",
        storedWalletAddress: "0xEXPECTED",
        onChainSender: "0xATTACKER",
        detectedAt: expect.any(Date),
      },
    ]);
  });

  it("caps the scanned range per run instead of scanning a large gap in one call", async () => {
    const { chain, getEventsCalls } = makeFakeChain({ latestBlock: 100_000n, events: [] });
    const repository = new FakeSettlementRepository([], 0n);
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute();

    const expectedToBlock = 1n + MAX_BLOCK_RANGE_PER_RUN;
    expect(getEventsCalls).toEqual([{ fromBlock: 1n, toBlock: expectedToBlock }]);
    expect(summary.toBlock).toBe(expectedToBlock.toString());
    expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(expectedToBlock);
  });

  it("no-ops without calling getEvents when the cursor has already caught up to the latest block", async () => {
    const { chain, getEventsCalls } = makeFakeChain({ latestBlock: 50n, events: [] });
    const repository = new FakeSettlementRepository([], 50n);
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute();

    expect(getEventsCalls).toEqual([]);
    expect(summary.eventsFound).toBe(0);
  });
});

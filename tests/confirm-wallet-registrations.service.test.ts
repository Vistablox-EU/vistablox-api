import { describe, expect, it } from "vitest";

import { ConfirmWalletRegistrationsService } from "../src/modules/settlement/application/confirm-wallet-registrations.service.js";
import { FakeWalletRegistrationRepository, makeFakeChain } from "./support/wallet-registration-fakes.js";

const MAX_BLOCK_RANGE_PER_RUN = 2000n;
const CONFIRMATION_DEPTH = 3n;

// The evidence behaviour of this job (identity persistence, replay,
// reorganization) is in confirm-wallet-registrations-evidence.service.test.ts.

describe("ConfirmWalletRegistrationsService", () => {
  it("confirms a pending registration when the event's commitment and wallet both match", async () => {
    const { chain } = makeFakeChain({
      latestBlock: 100n,
      events: [{ blockNumber: 50n, wallet: "0xABC", commitment: "0xC1" }],
    });
    const repository = new FakeWalletRegistrationRepository(
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
    const repository = new FakeWalletRegistrationRepository([], 10n, 2);
    const service = new ConfirmWalletRegistrationsService(repository, chain as never, () => new Date("2026-09-16T10:00:00Z"));

    const summary = await service.execute();

    expect(summary.pendingRegistrationsOverdue).toBe(2);
  });

  it("uses the configured overdue threshold and reports it in the summary", async () => {
    const { chain } = makeFakeChain({ latestBlock: 100n, events: [] });
    const repository = new FakeWalletRegistrationRepository([], 10n, 1);
    const now = new Date("2026-09-16T10:00:00Z");
    const service = new ConfirmWalletRegistrationsService(repository, chain as never, () => now, 15 * 60_000);

    const summary = await service.execute();

    expect(repository.overdueCutoff?.toISOString()).toBe("2026-09-16T09:45:00.000Z");
    expect(summary.pendingWarnAfterMinutes).toBe(15);
  });

  it("starts watching from the latest confirmed block, not the mutable chain head, on the very first run", async () => {
    const { chain, getEventsCalls } = makeFakeChain({ latestBlock: 500n, events: [] });
    const repository = new FakeWalletRegistrationRepository([], null);
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
    const repository = new FakeWalletRegistrationRepository([], 10n);
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
    const repository = new FakeWalletRegistrationRepository(
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
    const repository = new FakeWalletRegistrationRepository([], 0n);
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute();

    const expectedToBlock = MAX_BLOCK_RANGE_PER_RUN;
    expect(getEventsCalls).toEqual([{ fromBlock: 0n, toBlock: expectedToBlock }]);
    expect(summary.toBlock).toBe(expectedToBlock.toString());
    expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(expectedToBlock);
  });

  it("rescans the recent overlap even when the cursor has caught up to the safe head", async () => {
    const { chain, getEventsCalls } = makeFakeChain({ latestBlock: 50n, events: [] });
    const repository = new FakeWalletRegistrationRepository([], 50n);
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
    const repository = new FakeWalletRegistrationRepository(
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
    const repository = new FakeWalletRegistrationRepository([], 100n);
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    await expect(service.execute()).rejects.toThrow("RPC log query failed");
    expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(100n);
  });

  it("is idempotent when an overlapping range returns the same event twice", async () => {
    const event = { blockNumber: 95n, wallet: "0xABC", commitment: "0xc1" };
    const { chain } = makeFakeChain({ latestBlock: 120n, events: [event, event] });
    const repository = new FakeWalletRegistrationRepository(
      [{ accountId: "acct_01", walletAddress: "0xabc", commitment: "0xc1" }],
      100n,
    );
    const service = new ConfirmWalletRegistrationsService(repository, chain as never, () => new Date());

    const summary = await service.execute();

    expect(summary.eventsFound).toBe(2);
    expect(summary.registrationsConfirmed).toBe(1);
    expect(repository.confirmedAccountIds).toEqual(["acct_01"]);
  });
});

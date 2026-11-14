import { describe, expect, it, vi } from "vitest";

import {
  ConfirmWalletRegistrationsService,
  type WalletRegistrationMismatchSignal,
} from "../src/modules/settlement/application/confirm-wallet-registrations.service.js";
import { RunWalletRegistryWatcherService } from "../src/modules/settlement/application/run-wallet-registry-watcher.service.js";
import { WalletRegistryAlertReporter } from "../src/modules/settlement/application/wallet-registry-alert-reporter.js";
import { WorkerMetrics } from "../src/shared/health/worker-metrics.js";
import { FakeWalletRegistrationRepository, makeFakeChain } from "./support/wallet-registration-fakes.js";

const MAX_BLOCK_RANGE_PER_RUN = 2000n;
const CONFIRMATION_DEPTH = 3n;

// Realistic values: a 40-hex address and a 64-hex commitment. The masks and the
// "no full value in a log line" checks below only mean something on these.
const STORED_WALLET = "0xAbCdEf0123456789aBcDeF0123456789abcdef01";
const ATTACKER_WALLET = "0x9999999999aaaaaaaaaa0000000000bbbbbbbbbb";
const SECOND_ATTACKER_WALLET = "0x7777777777cccccccccc1111111111dddddddddd";
const COMMITMENT = `0x${"c0de".repeat(16)}`;
const FULL_HEX_RUN = /0x[0-9a-fA-F]{12,}/;

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
      events: [{ blockNumber: 15n, wallet: ATTACKER_WALLET, commitment: COMMITMENT }],
    });
    const repository = new FakeWalletRegistrationRepository(
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
    const repository = new FakeWalletRegistrationRepository(
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
    const repository = new FakeWalletRegistrationRepository(
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
    const repository = new FakeWalletRegistrationRepository(
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
    const repository = new FakeWalletRegistrationRepository(
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

  describe("newUnmatchedEvents", () => {
    // unmatchedEvents counts every event whose commitment belongs to no
    // registration row at all (an event for a row that exists is classified as
    // a confirmation, a replay or a conflict). newUnmatchedEvents is the part
    // that is news: an event in a block past the cursor an earlier completed
    // run reached.
    const UNKNOWN_COMMITMENT = `0x${"f00d".repeat(16)}`;

    it("does not count the overlap replay of a registration that was just confirmed", async () => {
      const { chain } = makeFakeChain({
        latestBlock: 20n,
        events: [{ blockNumber: 15n, wallet: STORED_WALLET, commitment: COMMITMENT }],
      });
      const repository = new FakeWalletRegistrationRepository(
        [{ accountId: "acct_01", walletAddress: STORED_WALLET, commitment: COMMITMENT }],
        10n,
      );
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const first = await service.execute();
      const second = await service.execute();

      expect(first).toMatchObject({ registrationsConfirmed: 1, unmatchedEvents: 0, newUnmatchedEvents: 0 });
      // The cursor is 17 now; block 15 is replayed. The row exists (it is
      // registered, with this very event), so the event is a replay of a
      // confirmation, not an unmatched one.
      expect(second).toMatchObject({ eventsFound: 1, unmatchedEvents: 0, newUnmatchedEvents: 0, eventsReplayed: 1 });
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
      const repository = new FakeWalletRegistrationRepository([], 50n);
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
      const repository = new FakeWalletRegistrationRepository([], 50n);
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const summary = await service.execute();

      expect(summary).toMatchObject({ unmatchedEvents: 1, newUnmatchedEvents: 1 });
    });

    it("counts every unmatched event on the first run, when there is no cursor to compare with", async () => {
      const { chain } = makeFakeChain({
        latestBlock: 500n,
        events: [{ blockNumber: 497n, wallet: STORED_WALLET, commitment: UNKNOWN_COMMITMENT }],
      });
      const repository = new FakeWalletRegistrationRepository([], null);
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const summary = await service.execute();

      expect(summary).toMatchObject({ unmatchedEvents: 1, newUnmatchedEvents: 1 });
    });
  });

  describe("safeHeadBlock", () => {
    it("reports the safe head the run worked against", async () => {
      const { chain } = makeFakeChain({ latestBlock: 120n, events: [] });
      const repository = new FakeWalletRegistrationRepository([], 100n);
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const summary = await service.execute();

      expect(summary.safeHeadBlock).toBe("117");
    });

    it("reports the real safe head, not this run's capped toBlock, when a long gap is being caught up", async () => {
      const { chain } = makeFakeChain({ latestBlock: 100_000n, events: [] });
      const repository = new FakeWalletRegistrationRepository([], 0n);
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const summary = await service.execute();

      expect(summary.toBlock).toBe("2000");
      expect(summary.safeHeadBlock).toBe("99997");
    });

    it("reports it on the early-return path where the cursor is ahead of the chain", async () => {
      const { chain, getEventsCalls } = makeFakeChain({ latestBlock: 50n, events: [] });
      const repository = new FakeWalletRegistrationRepository([], 100n);
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const summary = await service.execute();

      expect(getEventsCalls).toEqual([]);
      expect(summary.safeHeadBlock).toBe("47");
      expect(await repository.getLastProcessedWalletRegistryBlock()).toBe(100n);
    });

    it("clamps to zero on a chain younger than the confirmation depth", async () => {
      const { chain } = makeFakeChain({ latestBlock: 1n, events: [] });
      const repository = new FakeWalletRegistrationRepository([], null);
      const service = new ConfirmWalletRegistrationsService(repository, chain as never);

      const summary = await service.execute();

      expect(summary.safeHeadBlock).toBe("0");
    });
  });
});

// The claim (an audit_log.event_key row) is stored the moment a mismatch is first
// seen, but a run can fail after that: a later event's write throws, or the
// cursor read after the run does. The retry re-reads the same event, finds the
// claim and counts a repeat, so a signal announced only when a run completes is
// announced at most once. These tests run the real service, runner and reporter
// together and check what reached the log, not what the pieces were told.
describe("announcing a first-seen address mismatch when the run later fails", () => {
  const SECOND_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
  const SECOND_COMMITMENT = `0x${"beef".repeat(16)}`;

  function assemble(options: { failCursorRead?: boolean } = {}) {
    // Block 15: a mismatch for acct_01. Block 16: a legitimate registration for
    // acct_02, whose confirm throws on the first run only.
    const { chain } = makeFakeChain({
      latestBlock: 20n,
      events: [
        { blockNumber: 15n, wallet: ATTACKER_WALLET, commitment: COMMITMENT },
        { blockNumber: 16n, wallet: SECOND_WALLET, commitment: SECOND_COMMITMENT },
      ],
    });
    const repository = new FakeWalletRegistrationRepository(
      [
        { accountId: "acct_01", walletAddress: STORED_WALLET, commitment: COMMITMENT },
        { accountId: "acct_02", walletAddress: SECOND_WALLET, commitment: SECOND_COMMITMENT },
      ],
      10n,
    );
    if (options.failCursorRead !== true) repository.failConfirmOnceFor.add("acct_02");

    const logged: Array<{ level: string; fields: Record<string, unknown> }> = [];
    const at = (level: string) => vi.fn((fields: Record<string, unknown>) => void logged.push({ level, fields }));
    const metrics = new WorkerMetrics();
    const reporter = new WalletRegistryAlertReporter({
      logger: { info: at("info"), warn: at("warn"), error: at("error") } as never,
      metrics,
      heartbeats: { recordWatcherHeartbeat: async () => {} },
      thresholds: {
        watcherStaleAfterMs: 600_000,
        cursorLagAlertBlocks: 900n,
        cursorAheadToleranceBlocks: 32n,
        pendingOverdueAlertCount: 1,
        unmatchedEventsAlertCount: 5,
      },
      jobs: { watcher: "settlement.confirm_wallet_registrations", health: "settlement.check_wallet_registry_health" },
    });
    let cursorReadsLeftToFail = options.failCursorRead === true ? 1 : 0;
    const runner = new RunWalletRegistryWatcherService(
      new ConfirmWalletRegistrationsService(repository, chain as never),
      {
        getLastProcessedWalletRegistryBlock: async () => {
          if (cursorReadsLeftToFail > 0) {
            cursorReadsLeftToFail -= 1;
            throw new Error("database blip");
          }
          return repository.getLastProcessedWalletRegistryBlock();
        },
      },
      reporter,
      () => "req_run",
    );
    const announced = () =>
      logged.filter((line) => line.fields.event === "wallet_registry.address_mismatch" && line.fields.account_id === "acct_01");
    return { runner, repository, metrics, announced };
  }

  it("still announces the mismatch once when a later event in the same run throws", async () => {
    const { runner, repository, announced, metrics } = assemble();

    await expect(runner.execute()).rejects.toThrow("database blip");
    // The claim is durable and the run is lost, so this run's log is all there is.
    expect(repository.recordedMismatches).toHaveLength(1);
    expect(announced()).toHaveLength(1);
    expect(announced()[0]).toMatchObject({ level: "error", fields: { severity: "error", trace_id: "req_run" } });
    expect(metrics.render()).toContain("vistablox_worker_wallet_registration_address_mismatches_total 1");

    // The retry succeeds and reads the same mismatch again: not news.
    await runner.execute();
    expect(repository.confirmedAccountIds).toEqual(["acct_02"]);
    expect(announced()).toHaveLength(1);
    expect(metrics.render()).toContain("vistablox_worker_wallet_registration_address_mismatches_total 1");
    expect(metrics.render()).toContain("vistablox_worker_wallet_registration_address_mismatch_duplicates_total 1");
  });

  it("still announces it once when the run's work is done and the cursor read after it throws", async () => {
    const { runner, repository, announced } = assemble({ failCursorRead: true });

    await expect(runner.execute()).rejects.toThrow("database blip");
    expect(repository.recordedMismatches).toHaveLength(1);
    expect(announced()).toHaveLength(1);

    await runner.execute();
    expect(announced()).toHaveLength(1);
  });
});

describe("the mismatch hook", () => {
  const SECOND_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
  const SECOND_COMMITMENT = `0x${"beef".repeat(16)}`;

  it("hands each first-seen mismatch over once, right after its claim and before the next event is processed", async () => {
    const { chain } = makeFakeChain({
      latestBlock: 20n,
      events: [
        { blockNumber: 15n, wallet: ATTACKER_WALLET, commitment: COMMITMENT },
        { blockNumber: 15n, wallet: ATTACKER_WALLET, commitment: COMMITMENT },
        { blockNumber: 16n, wallet: SECOND_WALLET, commitment: SECOND_COMMITMENT },
      ],
    });
    const repository = new FakeWalletRegistrationRepository(
      [
        { accountId: "acct_01", walletAddress: STORED_WALLET, commitment: COMMITMENT },
        { accountId: "acct_02", walletAddress: SECOND_WALLET, commitment: SECOND_COMMITMENT },
      ],
      10n,
    );
    const order: string[] = [];
    const confirm = repository.confirmWalletRegistration.bind(repository);
    repository.confirmWalletRegistration = async (input) => {
      order.push(`confirm ${input.accountId}`);
      return confirm(input);
    };
    const handedOver: WalletRegistrationMismatchSignal[] = [];
    const service = new ConfirmWalletRegistrationsService(repository, chain as never);

    const summary = await service.execute({
      onAddressMismatch: (signal) => {
        order.push(`hook ${signal.accountId}`);
        handedOver.push(signal);
      },
    });

    expect(order).toEqual(["hook acct_01", "confirm acct_02"]);
    // The same signal objects as the summary's: nothing is derived twice.
    expect(handedOver).toEqual(summary.addressMismatches);
    expect(summary.addressMismatchesRepeated).toBe(1);
    expect(JSON.stringify(handedOver)).not.toMatch(FULL_HEX_RUN);
  });

  it("is optional", async () => {
    const { chain } = makeFakeChain({
      latestBlock: 20n,
      events: [{ blockNumber: 15n, wallet: ATTACKER_WALLET, commitment: COMMITMENT }],
    });
    const repository = new FakeWalletRegistrationRepository(
      [{ accountId: "acct_01", walletAddress: STORED_WALLET, commitment: COMMITMENT }],
      10n,
    );

    const summary = await new ConfirmWalletRegistrationsService(repository, chain as never).execute();

    expect(summary.addressMismatches).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";

import { ConfirmWalletRegistrationsService } from "../src/modules/settlement/application/confirm-wallet-registrations.service.js";
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

// The "new" counters of the watcher's summary, which AD-284's per-run alerts key
// on: an event in a block past the cursor an earlier completed run reached, so
// the overlap re-read of the same event does not alert twice.

const NOW = new Date("2026-11-13T12:00:00.000Z");
const WALLET = "0xabc";
const COMMITMENT = "0xc1";
const pendingSeed: FakeRegistrationSeed = { accountId: "acct_01", walletAddress: WALLET, commitment: COMMITMENT };

function harness(options: { cursor: bigint | null; events: FakeEvent[]; rows: FakeRegistrationSeed[] }) {
  const { chain } = makeFakeChain({ latestBlock: 100n, events: options.events });
  const repository = new FakeWalletRegistrationRepository(options.rows, options.cursor);
  const service = new ConfirmWalletRegistrationsService(
    repository,
    chain as never,
    () => NOW,
    undefined,
    new FakeEvidenceReader(),
  );
  return { service, repository };
}

const identityAt = (blockNumber: bigint) => ({
  transactionHash: defaultTransactionHash(blockNumber),
  blockHash: defaultBlockHash(blockNumber),
  blockNumber,
  logIndex: 0,
});
const original = { ...identityAt(60n), transactionHash: hash("77") };

describe("a different transaction from the registered wallet itself (AD-284)", () => {
  const event = (blockNumber: bigint, wallet = "0xABC"): FakeEvent => ({ blockNumber, wallet, commitment: "0xC1", logIndex: 0 });

  it("is counted as new for a complete, unflagged registration, in a block past the cursor", async () => {
    const { service } = harness({ cursor: 90n, rows: [confirmedRow(pendingSeed, original)], events: [event(95n)] });

    expect(await service.execute()).toMatchObject({ conflictingEvents: 1, newWalletConflictingEvents: 1 });
  });

  it("is not counted as new when the block was already read by a completed run", async () => {
    const { service } = harness({ cursor: 95n, rows: [confirmedRow(pendingSeed, original)], events: [event(95n)] });

    expect(await service.execute()).toMatchObject({ conflictingEvents: 1, newWalletConflictingEvents: 0 });
  });

  it("is not raised twice by the overlap re-read of the next run", async () => {
    const { service } = harness({ cursor: 90n, rows: [confirmedRow(pendingSeed, original)], events: [event(95n)] });

    const first = await service.execute();
    const second = await service.execute();

    expect(first.newWalletConflictingEvents).toBe(1);
    expect(second).toMatchObject({ eventsFound: 1, conflictingEvents: 1, newWalletConflictingEvents: 0 });
  });

  it("is never counted for an event from another sender, which anyone can send", async () => {
    const { service } = harness({
      cursor: 90n,
      rows: [confirmedRow(pendingSeed, original)],
      events: [event(95n, "0x9999999999aaaaaaaaaa0000000000bbbbbbbbbb")],
    });

    expect(await service.execute()).toMatchObject({ conflictingEvents: 1, newWalletConflictingEvents: 0 });
  });

  it("is never counted for a flagged registration", async () => {
    const { service } = harness({
      cursor: 90n,
      rows: [{ ...confirmedRow(pendingSeed, original), flaggedAt: NOW, flag: "event_missing" }],
      events: [event(95n)],
    });

    expect(await service.execute()).toMatchObject({ conflictingEvents: 1, newWalletConflictingEvents: 0 });
  });

  it("is never counted for the same transaction at another log index", async () => {
    const { service } = harness({
      cursor: 90n,
      rows: [confirmedRow(pendingSeed, identityAt(95n))],
      events: [{ ...event(95n), logIndex: 3 }],
    });

    expect(await service.execute()).toMatchObject({ conflictingEvents: 1, newWalletConflictingEvents: 0 });
  });
});

describe("a confirmation conflict (AD-284)", () => {
  const rows = [pendingSeed];
  const event = (blockNumber: bigint): FakeEvent => ({ blockNumber, wallet: "0xABC", commitment: "0xC1" });

  it("is counted as new in a block past the cursor", async () => {
    const { service, repository } = harness({ cursor: 90n, rows, events: [event(95n)] });
    repository.forcedConfirmOutcome = "address_conflict";

    expect(await service.execute()).toMatchObject({ confirmationConflicts: 1, newConfirmationConflicts: 1 });
  });

  it("is not counted as new in a block a completed run already read", async () => {
    const { service, repository } = harness({ cursor: 95n, rows, events: [event(95n)] });
    repository.forcedConfirmOutcome = "address_conflict";

    expect(await service.execute()).toMatchObject({ confirmationConflicts: 1, newConfirmationConflicts: 0 });
  });
});

describe("events without a complete identity (AD-284)", () => {
  const removed = (blockNumber: bigint, wallet = "0xABC"): FakeEvent => ({
    blockNumber,
    wallet,
    commitment: "0xC1",
    removed: true,
  });

  it("counts a pending claim's own event in a new block, and not one at or before the cursor", async () => {
    const fresh = harness({ cursor: 90n, rows: [pendingSeed], events: [removed(95n)] });
    const replayed = harness({ cursor: 95n, rows: [pendingSeed], events: [removed(95n)] });

    expect(await fresh.service.execute()).toMatchObject({ eventsWithoutIdentity: 1, newEventsWithoutIdentity: 1 });
    expect(await replayed.service.execute()).toMatchObject({ eventsWithoutIdentity: 1, newEventsWithoutIdentity: 0 });
  });

  it("counts an event of a confirmed registration whatever its sender", async () => {
    const { service } = harness({
      cursor: 90n,
      rows: [confirmedRow(pendingSeed, original)],
      events: [removed(95n, "0x9999999999aaaaaaaaaa0000000000bbbbbbbbbb")],
    });

    expect(await service.execute()).toMatchObject({ eventsWithoutIdentity: 1, newEventsWithoutIdentity: 1 });
  });

  it("leaves a pending claim's event from another sender to the address mismatch, and one for no claim to the unmatched count", async () => {
    const { service } = harness({
      cursor: 90n,
      rows: [pendingSeed],
      events: [
        removed(95n, "0x9999999999aaaaaaaaaa0000000000bbbbbbbbbb"),
        { blockNumber: 96n, wallet: "0xABC", commitment: "0xdeadbeef", removed: true },
      ],
    });

    expect(await service.execute()).toMatchObject({
      eventsWithoutIdentity: 0,
      newEventsWithoutIdentity: 0,
      unmatchedEvents: 1,
    });
  });
});

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type {
  CoinbaseCdpClient,
  OnrampTransactionSummary,
} from "../src/modules/offering/application/coinbase-cdp-client.js";
import { ReconcileOnrampWebhookService } from "../src/modules/offering/application/coinbase-onramp-webhook.service.js";
import { PollOnrampTransactionsService } from "../src/modules/offering/application/poll-onramp-transactions.service.js";
import { RecordOnrampLateEvidenceService } from "../src/modules/offering/application/record-onramp-late-evidence.service.js";
import { decideOnrampRecording } from "../src/modules/offering/domain/onramp-outcome-recording.policy.js";
import type {
  OnrampLateEvidenceRecorder,
  RecordOnrampLateEvidenceInput,
} from "../src/modules/offering/repository/onramp-late-evidence.repository.js";
import type {
  OnrampOutcomeRecording,
  RecordOnrampOutcomeInput,
  ReservationRepository,
} from "../src/modules/offering/repository/reservation.repository.js";

// The route a late Coinbase success takes in the worker, with the real services
// and in-memory stand-ins for the two repositories: the webhook job (or the
// poll) -> the poller's reconcileReservation -> the recording method's
// other_stage outcome -> RecordOnrampLateEvidenceService -> the evidence list.
// The stand-in recording method applies the real decision policy, so a stage
// other than 'initiated' answers other_stage exactly as the database one does.
// What the database itself enforces is in onramp-late-evidence.integration.test.ts.

const wallet = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const observedAt = new Date("2026-11-17T12:00:00.000Z");
const silent = pino({ level: "silent" });

function transaction(overrides: Partial<OnrampTransactionSummary> = {}): OnrampTransactionSummary {
  return {
    transactionId: "txn_late",
    status: "success",
    walletAddress: wallet,
    purchaseCurrency: "EURC",
    purchaseAmountValue: "950.000000",
    paymentTotalCurrency: "EUR",
    paymentTotalValue: "1000.00",
    txHash: "0xabc",
    createdAt: new Date("2026-11-17T11:40:00.000Z"),
    completedAt: new Date("2026-11-17T11:50:00.000Z"),
    ...overrides,
  };
}

function world(stage: string, latestCapitalState: string | null = "eurc_purchase_pending") {
  const recorded: RecordOnrampOutcomeInput[] = [];
  const reservations = {
    findReservationForOnrampReconciliation: vi.fn().mockResolvedValue({
      reservationId: "reservation_01",
      accountId: "account_01",
      amountEur: "1000.00",
      reservationStage: stage,
    }),
    listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([]),
    recordOnrampOutcome: vi.fn(async (input: RecordOnrampOutcomeInput): Promise<OnrampOutcomeRecording> => {
      const decision = decideOnrampRecording({
        reservationStage: stage,
        latestCapitalState,
        outcomeAlreadyRecorded: recorded.some(
          (event) => event.providerReference === input.providerReference && event.capitalState === input.capitalState,
        ),
      });
      if (decision === "other_stage") return { status: "other_stage", reservationStage: stage, latestCapitalState };
      if (decision !== "record") return { status: decision as "duplicate" };
      recorded.push(input);
      return { status: "recorded" };
    }),
  } as unknown as ReservationRepository;

  // Idempotent on the provider transaction id, like the table's unique index.
  const entries = new Map<string, RecordOnrampLateEvidenceInput>();
  const recorder: OnrampLateEvidenceRecorder = {
    recordLateEvidence: vi.fn(async (input: RecordOnrampLateEvidenceInput) => {
      const existing = entries.has(input.providerTransactionId);
      if (!existing) entries.set(input.providerTransactionId, input);
      return { evidenceId: `evidence_for_${input.providerTransactionId}`, newlyRecorded: !existing };
    }),
  };

  const listBuyTransactions = vi.fn();
  const coinbase = {
    createOnrampSessionToken: vi.fn(),
    buildOnrampUrl: vi.fn(),
    listBuyTransactions,
  } as unknown as CoinbaseCdpClient;
  const poller = new PollOnrampTransactionsService(
    reservations,
    coinbase,
    silent,
    () => observedAt,
    new RecordOnrampLateEvidenceService(recorder, silent),
  );
  const job = new ReconcileOnrampWebhookService(reservations, poller);
  const shows = (...transactions: OnrampTransactionSummary[]) =>
    listBuyTransactions.mockResolvedValue({ transactions, nextPageKey: null });
  const webhook = (eventId = "evt_01") => ({
    reservationId: "reservation_01",
    eventId,
    eventType: "onramp.transaction.success",
    trace_id: "trace_job",
  });
  return { reservations, recorder, entries, recorded, poller, job, shows, webhook, listBuyTransactions };
}

describe("a late Coinbase success reaching the evidence list through the webhook job", () => {
  it.each([
    ["lapsed", "reservation_lapsed"],
    ["cancelled", "reservation_cancelled"],
  ])("lists a success for a %s reservation, with every field the list carries, and records no money", async (stage) => {
    const { job, shows, webhook, entries, recorded } = world(stage);
    shows(transaction());

    const result = await job.execute(webhook());

    expect(result).toMatchObject({ status: "resolved", recording: "other_stage" });
    expect([...entries.values()]).toEqual([
      {
        providerTransactionId: "txn_late",
        txHash: "0xabc",
        destinationWallet: wallet,
        reservationId: "reservation_01",
        reservationStage: stage,
        amount: "950.000000",
        asset: "EURC",
        state: "eurc_reserved",
        observedAt,
        traceId: "trace_job",
      },
    ]);
    // The recording method wrote no money event for it: it can never count as funding.
    expect(recorded).toEqual([]);
  });

  it("keeps a late success that does not cover the reservation, in its own state", async () => {
    const { job, shows, webhook, entries } = world("lapsed");
    shows(transaction({ transactionId: "txn_wrong_asset", purchaseCurrency: "ETH", purchaseAmountValue: "0.200000" }));

    await job.execute(webhook());

    expect([...entries.values()]).toEqual([
      expect.objectContaining({ providerTransactionId: "txn_wrong_asset", asset: "ETH", amount: "0.200000", state: "purchase_failed" }),
    ]);
  });

  it("lists nothing for a late failed attempt: no money moved", async () => {
    const { job, shows, webhook, entries, recorder } = world("cancelled");
    shows(transaction({ status: "failed", transactionId: "txn_failed" }));

    const result = await job.execute({ ...webhook(), eventType: "onramp.transaction.failed" });

    expect(result).toMatchObject({ status: "resolved", recording: "other_stage" });
    expect(entries.size).toBe(0);
    expect(recorder.recordLateEvidence).not.toHaveBeenCalled();
  });

  it("lists the one transaction the recording method was asked about: the covering success, not every success the list shows", async () => {
    const { job, shows, webhook, entries } = world("lapsed");
    shows(
      transaction({ transactionId: "txn_small", purchaseAmountValue: "10.000000" }),
      transaction({ transactionId: "txn_covering", purchaseAmountValue: "990.000000" }),
      transaction({ transactionId: "txn_failed", status: "failed" }),
    );

    await job.execute(webhook());

    // One transaction per reservation per observation, as the recording method records one.
    expect([...entries.values()].map((entry) => [entry.providerTransactionId, entry.state])).toEqual([
      ["txn_covering", "eurc_reserved"],
    ]);
  });

  it("is idempotent on the provider transaction: a redelivered webhook and the poll's re-check leave one entry", async () => {
    const { job, poller, shows, webhook, entries, recorder } = world("lapsed");
    shows(transaction());

    await job.execute(webhook("evt_01"));
    await job.execute(webhook("evt_02"));
    await poller.reconcileReservation({ reservationId: "reservation_01", amountEur: "1000.00" }, "trace_poll");

    expect(entries.size).toBe(1);
    expect(recorder.recordLateEvidence).toHaveBeenCalledTimes(3);
    // The first sighting is the one on file.
    expect([...entries.values()][0]?.traceId).toBe("trace_job");
  });

  it("retries rather than drops a terminal event whose outcome Coinbase does not show yet", async () => {
    const { job, shows, webhook, entries } = world("lapsed");
    shows();

    await expect(job.execute(webhook())).rejects.toThrow(/does not show the outcome yet/);
    expect(entries.size).toBe(0);
  });
});

describe("the minute poll no longer watches abandoned reservations", () => {
  it("asks Coinbase about nothing when only lapsed or cancelled reservations exist: it lists initiated ones only", async () => {
    const { poller, reservations, listBuyTransactions } = world("lapsed");

    const summary = await poller.execute("trace_poll");

    expect(summary).toEqual({ checked: 0, acted: 0, failed: 0 });
    expect(reservations.listPendingPurchaseReservationsForTimers).toHaveBeenCalledTimes(1);
    expect(listBuyTransactions).not.toHaveBeenCalled();
  });

  it("hands a late success the poll itself met (the lapse landed between its list and its lock) to the same path", async () => {
    const { reservations, entries, recorder } = world("lapsed");
    const poller = new PollOnrampTransactionsService(
      {
        ...(reservations as object),
        listPendingPurchaseReservationsForTimers: vi
          .fn()
          .mockResolvedValue([{ reservationId: "reservation_01", accountId: "account_01", amountEur: "1000.00" }]),
      } as unknown as ReservationRepository,
      { listBuyTransactions: vi.fn().mockResolvedValue({ transactions: [transaction()], nextPageKey: null }) } as unknown as CoinbaseCdpClient,
      silent,
      () => observedAt,
      new RecordOnrampLateEvidenceService(recorder, silent),
    );

    const summary = await poller.execute("trace_poll");

    // Not counted as acted on: only a written money event is.
    expect(summary).toEqual({ checked: 1, acted: 0, failed: 0 });
    expect([...entries.values()]).toEqual([expect.objectContaining({ providerTransactionId: "txn_late", traceId: "trace_poll" })]);
  });
});

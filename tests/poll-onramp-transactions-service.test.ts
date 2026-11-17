import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type {
  CoinbaseCdpClient,
  OnrampTransactionSummary,
} from "../src/modules/offering/application/coinbase-cdp-client.js";
import type { OtherStageOnrampOutcomeHandler } from "../src/modules/offering/application/other-stage-onramp-outcome.js";
import {
  MAX_ONRAMP_TRANSACTION_PAGES,
  OnrampPollIncompleteError,
  PollOnrampTransactionsService,
  isPurchaseCovering,
} from "../src/modules/offering/application/poll-onramp-transactions.service.js";
import type {
  OnrampOutcomeRecording,
  PendingPurchaseReservationForTimer,
  ReservationRepository,
} from "../src/modules/offering/repository/reservation.repository.js";

const now = new Date("2026-09-02T10:00:00.000Z");
const logger = pino({ level: "silent" });
const recorded: OnrampOutcomeRecording = { status: "recorded" };

function pending(
  overrides: Partial<PendingPurchaseReservationForTimer> = {},
): PendingPurchaseReservationForTimer {
  return { reservationId: "reservation_01", accountId: "account_01", amountEur: "1000.00", ...overrides };
}

function transaction(overrides: Partial<OnrampTransactionSummary> = {}): OnrampTransactionSummary {
  return {
    transactionId: "txn_01",
    status: "success",
    walletAddress: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    purchaseCurrency: "EURC",
    purchaseAmountValue: "950.000000",
    paymentTotalCurrency: "EUR",
    paymentTotalValue: "1000.00",
    txHash: "0xabc",
    createdAt: new Date("2026-09-02T09:50:00.000Z"),
    completedAt: new Date("2026-09-02T09:55:00.000Z"),
    ...overrides,
  };
}

function repository(overrides: Partial<ReservationRepository> = {}): ReservationRepository {
  return {
    createReservation: vi.fn(),
    recordMoneyEvent: vi.fn().mockResolvedValue(true),
    listInitiatedReservationsForTimers: vi.fn().mockResolvedValue([]),
    expireReservation: vi.fn(),
    listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([]),
    findReservationForOnrampReconciliation: vi.fn().mockResolvedValue(null),
    recordOnrampOutcome: vi.fn().mockResolvedValue(recorded),
    ...overrides,
  };
}

function coinbase(overrides: Partial<CoinbaseCdpClient> = {}): CoinbaseCdpClient {
  return {
    createOnrampSessionToken: vi.fn(),
    buildOnrampUrl: vi.fn(),
    listBuyTransactions: vi.fn().mockResolvedValue({ transactions: [], nextPageKey: null }),
    ...overrides,
  };
}

describe("PollOnrampTransactionsService", () => {
  it("advances a successful purchase that covers the reservation to eurc_reserved", async () => {
    const recordOnrampOutcome = vi.fn().mockResolvedValue(recorded);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction()],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(listBuyTransactions).toHaveBeenCalledWith({ partnerUserRef: "reservation_01" });
    expect(recordOnrampOutcome).toHaveBeenCalledWith({
      reservationId: "reservation_01",
      provider: "coinbase_cdp",
      providerReference: "txn_01",
      capitalState: "eurc_reserved",
      amountEur: "1000.00",
      amountEurc: "950.000000",
      recordedAt: now,
    });
    expect(summary).toEqual({ checked: 1, acted: 1, failed: 0 });
  });

  it("records purchase_failed for a success that does not cover the reservation (wrong asset)", async () => {
    const recordOnrampOutcome = vi.fn().mockResolvedValue(recorded);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction({ transactionId: "txn_wrong_asset", purchaseCurrency: "ETH" })],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "reservation_01",
        capitalState: "purchase_failed",
        providerReference: "txn_wrong_asset",
        amountEurc: null,
      }),
    );
  });

  it("records purchase_failed for a success that lands far below the reserved amount", async () => {
    const recordOnrampOutcome = vi.fn().mockResolvedValue(recorded);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction({ transactionId: "txn_underfunded", purchaseAmountValue: "500.000000" })],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        capitalState: "purchase_failed",
        providerReference: "txn_underfunded",
        amountEurc: null,
      }),
    );
  });

  it("records purchase_failed for a zero-value success, not eurc_reserved", async () => {
    const recordOnrampOutcome = vi.fn().mockResolvedValue(recorded);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction({ transactionId: "txn_zero", purchaseAmountValue: "0.000000" })],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "purchase_failed", providerReference: "txn_zero" }),
    );
    expect(recordOnrampOutcome).not.toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "eurc_reserved" }),
    );
  });

  it("records purchase_failed only once nothing is still in flight", async () => {
    const recordOnrampOutcome = vi.fn().mockResolvedValue(recorded);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction({ transactionId: "txn_failed", status: "failed" })],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "reservation_01",
        capitalState: "purchase_failed",
        providerReference: "txn_failed",
        amountEurc: null,
      }),
    );
    expect(summary).toEqual({ checked: 1, acted: 1, failed: 0 });
  });

  it("leaves capital_state alone while a transaction is still in flight, even alongside a failed attempt", async () => {
    const recordOnrampOutcome = vi.fn();
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [
        transaction({ transactionId: "txn_retry_failed", status: "failed" }),
        transaction({ transactionId: "txn_retry_active", status: "in_progress" }),
      ],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(recordOnrampOutcome).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0, failed: 0 });
  });

  it("prefers a success over an earlier failed attempt on the same reservation", async () => {
    const recordOnrampOutcome = vi.fn().mockResolvedValue(recorded);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [
        transaction({ transactionId: "txn_first_failed", status: "failed" }),
        transaction({ transactionId: "txn_retry_success", status: "success" }),
      ],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "eurc_reserved", providerReference: "txn_retry_success" }),
    );
  });

  it("funds from a covering success even when an earlier success does not cover", async () => {
    const recordOnrampOutcome = vi.fn().mockResolvedValue(recorded);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [
        transaction({ transactionId: "txn_small", purchaseAmountValue: "100.000000" }),
        transaction({ transactionId: "txn_covering", purchaseAmountValue: "960.000000" }),
      ],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordOnrampOutcome).toHaveBeenCalledTimes(1);
    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        capitalState: "eurc_reserved",
        providerReference: "txn_covering",
        amountEurc: "960.000000",
      }),
    );
  });

  it("waits for an in-flight retry instead of failing on a non-covering success", async () => {
    const recordOnrampOutcome = vi.fn();
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [
        transaction({ transactionId: "txn_small", purchaseAmountValue: "100.000000" }),
        transaction({ transactionId: "txn_retry", status: "in_progress" }),
      ],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(recordOnrampOutcome).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0, failed: 0 });
  });

  it("follows the page cursor and funds from a covering success on page 2", async () => {
    const recordOnrampOutcome = vi.fn().mockResolvedValue(recorded);
    const listBuyTransactions = vi
      .fn()
      .mockResolvedValueOnce({
        transactions: [transaction({ transactionId: "txn_page1_small", purchaseAmountValue: "10.000000" })],
        nextPageKey: "page_2",
      })
      .mockResolvedValueOnce({
        transactions: [transaction({ transactionId: "txn_page2_covering" })],
        nextPageKey: null,
      });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(listBuyTransactions).toHaveBeenNthCalledWith(1, { partnerUserRef: "reservation_01" });
    expect(listBuyTransactions).toHaveBeenNthCalledWith(2, { partnerUserRef: "reservation_01", pageKey: "page_2" });
    expect(recordOnrampOutcome).toHaveBeenCalledTimes(1);
    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "eurc_reserved", providerReference: "txn_page2_covering" }),
    );
  });

  it("stops at the page cap and records nothing when no covering success was seen", async () => {
    const recordOnrampOutcome = vi.fn();
    let page = 0;
    const listBuyTransactions = vi.fn().mockImplementation(async () => {
      page += 1;
      return {
        transactions: [transaction({ transactionId: `txn_failed_${page}`, status: "failed" })],
        nextPageKey: `page_${page + 1}`,
      };
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(listBuyTransactions).toHaveBeenCalledTimes(MAX_ONRAMP_TRANSACTION_PAGES);
    expect(recordOnrampOutcome).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0, failed: 0 });
  });

  it("still funds from a covering success seen before the page cap", async () => {
    const recordOnrampOutcome = vi.fn().mockResolvedValue(recorded);
    const listBuyTransactions = vi
      .fn()
      .mockResolvedValueOnce({ transactions: [transaction({ transactionId: "txn_covering" })], nextPageKey: "page_2" })
      .mockResolvedValue({ transactions: [], nextPageKey: "page_n" });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(listBuyTransactions).toHaveBeenCalledTimes(MAX_ONRAMP_TRANSACTION_PAGES);
    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "eurc_reserved", providerReference: "txn_covering" }),
    );
  });

  it("keeps polling the other reservations when one lookup fails, then fails the run with its counts", async () => {
    const recordOnrampOutcome = vi.fn().mockResolvedValue(recorded);
    const listBuyTransactions = vi.fn().mockImplementation(async ({ partnerUserRef }: { partnerUserRef: string }) => {
      if (partnerUserRef === "reservation_broken") throw new Error("Coinbase CDP request failed with HTTP 503");
      return { transactions: [transaction({ transactionId: `txn_${partnerUserRef}` })], nextPageKey: null };
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi
          .fn()
          .mockResolvedValue([
            pending({ reservationId: "reservation_a" }),
            pending({ reservationId: "reservation_broken" }),
            pending({ reservationId: "reservation_b" }),
          ]),
        recordOnrampOutcome,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const run = service.execute("trace_01");

    await expect(run).rejects.toBeInstanceOf(OnrampPollIncompleteError);
    await expect(run).rejects.toMatchObject({ summary: { checked: 3, acted: 2, failed: 1 } });
    expect(recordOnrampOutcome).toHaveBeenCalledTimes(2);
    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "reservation_a", capitalState: "eurc_reserved" }),
    );
    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "reservation_b", capitalState: "eurc_reserved" }),
    );
  });

  it("isolates a failed money-event write the same way as a failed lookup", async () => {
    const recordOnrampOutcome = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(recorded);
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi
          .fn()
          .mockResolvedValue([pending({ reservationId: "reservation_a" }), pending({ reservationId: "reservation_b" })]),
        recordOnrampOutcome,
      }),
      coinbase({
        listBuyTransactions: vi.fn().mockResolvedValue({ transactions: [transaction()], nextPageKey: null }),
      }),
      logger,
      () => now,
    );

    await expect(service.execute("trace_01")).rejects.toMatchObject({
      summary: { checked: 2, acted: 1, failed: 1 },
    });
    expect(recordOnrampOutcome).toHaveBeenCalledTimes(2);
  });

  it("does nothing when no transaction exists yet for the reservation", async () => {
    const recordOnrampOutcome = vi.fn();
    const service = new PollOnrampTransactionsService(
      repository({ listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]) }),
      coinbase(),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(recordOnrampOutcome).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0, failed: 0 });
  });
});

describe("isPurchaseCovering", () => {
  const base = transaction();

  it("accepts a fee-shortfall purchase inside the 90% tolerance band", () => {
    expect(isPurchaseCovering({ ...base, purchaseAmountValue: "900.000000" }, "1000.00")).toBe(true);
    expect(isPurchaseCovering({ ...base, purchaseAmountValue: "950.000000" }, "1000.00")).toBe(true);
  });

  it("rejects a purchase below the 90% tolerance band", () => {
    expect(isPurchaseCovering({ ...base, purchaseAmountValue: "899.999999" }, "1000.00")).toBe(false);
    expect(isPurchaseCovering({ ...base, purchaseAmountValue: "500.000000" }, "1000.00")).toBe(false);
  });

  it("rejects a non-EURC asset even at full value", () => {
    expect(isPurchaseCovering({ ...base, purchaseCurrency: "USDC", purchaseAmountValue: "1000.000000" }, "1000.00")).toBe(false);
  });

  it("rejects a zero or missing-value purchase", () => {
    expect(isPurchaseCovering({ ...base, purchaseAmountValue: "0.000000" }, "1000.00")).toBe(false);
  });
});
describe("PollOnrampTransactionsService honours what the recording method returns", () => {
  function polling(recording: OnrampOutcomeRecording, handler?: OtherStageOnrampOutcomeHandler) {
    const recordOnrampOutcome = vi.fn().mockResolvedValue(recording);
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome,
      }),
      coinbase({
        listBuyTransactions: vi.fn().mockResolvedValue({ transactions: [transaction()], nextPageKey: null }),
      }),
      logger,
      () => now,
      handler,
    );
    return { service, recordOnrampOutcome };
  }

  it.each<[string, OnrampOutcomeRecording]>([
    ["duplicate", { status: "duplicate" }],
    ["already_funded", { status: "already_funded" }],
    ["not_awaiting_purchase", { status: "not_awaiting_purchase", latestCapitalState: "eurc_reserved" }],
    ["unknown_reservation", { status: "unknown_reservation" }],
  ])("does not count a %s outcome as acted on", async (_label, recording) => {
    const { service, recordOnrampOutcome } = polling(recording);

    const summary = await service.execute("trace_01");

    expect(recordOnrampOutcome).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ checked: 1, acted: 0, failed: 0 });
  });

  it("counts only a recorded outcome as acted on", async () => {
    const { service } = polling(recorded);
    expect(await service.execute("trace_01")).toEqual({ checked: 1, acted: 1, failed: 0 });
  });

  it("hands an other_stage outcome to the late-evidence seam with everything an ops entry needs, and does not count it", async () => {
    const handleOtherStageOutcome = vi.fn().mockResolvedValue(undefined);
    const { service } = polling(
      { status: "other_stage", reservationStage: "lapsed", latestCapitalState: "eurc_purchase_pending" },
      { handleOtherStageOutcome },
    );

    const summary = await service.execute("trace_01");

    expect(handleOtherStageOutcome).toHaveBeenCalledTimes(1);
    expect(handleOtherStageOutcome).toHaveBeenCalledWith({
      reservationId: "reservation_01",
      reservationStage: "lapsed",
      latestCapitalState: "eurc_purchase_pending",
      providerTransactionId: "txn_01",
      txHash: "0xabc",
      destinationWallet: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
      amount: "950.000000",
      asset: "EURC",
      state: "eurc_reserved",
      observedAt: now,
      traceId: "trace_01",
    });
    expect(summary).toEqual({ checked: 1, acted: 0, failed: 0 });
  });

  it("logs an other_stage outcome by default, with ids and amounts but never the destination wallet", async () => {
    const lines: string[] = [];
    const capturing = pino({ level: "warn" }, { write: (line: string) => void lines.push(line) });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampOutcome: vi
          .fn()
          .mockResolvedValue({ status: "other_stage", reservationStage: "lapsed", latestCapitalState: "eurc_purchase_pending" }),
      }),
      coinbase({
        listBuyTransactions: vi.fn().mockResolvedValue({ transactions: [transaction()], nextPageKey: null }),
      }),
      capturing,
      () => now,
    );

    await service.execute("trace_01");

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({
      reservation_id: "reservation_01",
      reservation_stage: "lapsed",
      provider_reference: "txn_01",
      tx_hash: "0xabc",
      amount: "950.000000",
      asset: "EURC",
      outcome_state: "eurc_reserved",
    });
    expect(lines[0]).not.toContain("0x71C7656EC7ab88b098defB751B7401B5f6d8976F");
  });

  it("isolates a failing late-evidence handler like any other per-reservation failure", async () => {
    const handleOtherStageOutcome = vi.fn().mockRejectedValue(new Error("late path unavailable"));
    const { service } = polling(
      { status: "other_stage", reservationStage: "lapsed", latestCapitalState: null },
      { handleOtherStageOutcome },
    );

    await expect(service.execute("trace_01")).rejects.toMatchObject({
      summary: { checked: 1, acted: 0, failed: 1 },
    });
  });

  it("warns about an uncovered success only when it wrote the purchase_failed row", async () => {
    const uncovered = { transactions: [transaction({ purchaseCurrency: "ETH" })], nextPageKey: null };
    const run = async (recording: OnrampOutcomeRecording) => {
      const spied = pino({ level: "silent" });
      const warn = vi.spyOn(spied, "warn");
      const service = new PollOnrampTransactionsService(
        repository({
          listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
          recordOnrampOutcome: vi.fn().mockResolvedValue(recording),
        }),
        coinbase({ listBuyTransactions: vi.fn().mockResolvedValue(uncovered) }),
        spied,
        () => now,
      );
      await service.execute("trace_01");
      return warn;
    };

    expect(await run(recorded)).toHaveBeenCalledWith(
      expect.objectContaining({ provider_reference: "txn_01", reserved_amount_eur: "1000.00" }),
      "onramp success does not cover the reserved amount; recorded purchase_failed",
    );
    expect(await run({ status: "duplicate" })).not.toHaveBeenCalled();
  });
});

describe("PollOnrampTransactionsService.reconcileReservation", () => {
  function reconciling(transactions: OnrampTransactionSummary[], recording: OnrampOutcomeRecording = recorded) {
    const recordOnrampOutcome = vi.fn().mockResolvedValue(recording);
    const service = new PollOnrampTransactionsService(
      repository({ recordOnrampOutcome }),
      coinbase({ listBuyTransactions: vi.fn().mockResolvedValue({ transactions, nextPageKey: null }) }),
      logger,
      () => now,
    );
    return { service, recordOnrampOutcome };
  }

  it("works for a reservation in any stage: it needs only the id and the amount", async () => {
    const { service, recordOnrampOutcome } = reconciling([transaction()]);

    const result = await service.reconcileReservation({ reservationId: "reservation_lapsed", amountEur: "1000.00" }, "trace_01");

    expect(result).toEqual({
      status: "resolved",
      capitalState: "eurc_reserved",
      providerTransactionId: "txn_01",
      recording: recorded,
    });
    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "reservation_lapsed", providerReference: "txn_01" }),
    );
  });

  it("is unresolved, and records nothing, while Coinbase shows nothing concluded", async () => {
    const { service, recordOnrampOutcome } = reconciling([transaction({ status: "in_progress" })]);

    expect(await service.reconcileReservation(pending(), "trace_01")).toEqual({ status: "unresolved" });
    expect(recordOnrampOutcome).not.toHaveBeenCalled();
  });

  it("reports the failed purchase's own transaction as the thing to record", async () => {
    const { service } = reconciling([transaction({ transactionId: "txn_failed", status: "failed" })]);

    expect(await service.reconcileReservation(pending(), "trace_01")).toMatchObject({
      status: "resolved",
      capitalState: "purchase_failed",
      providerTransactionId: "txn_failed",
    });
  });
});

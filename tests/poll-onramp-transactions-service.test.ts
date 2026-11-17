import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type {
  CoinbaseCdpClient,
  OnrampTransactionSummary,
} from "../src/modules/offering/application/coinbase-cdp-client.js";
import {
  MAX_ONRAMP_TRANSACTION_PAGES,
  OnrampPollIncompleteError,
  PollOnrampTransactionsService,
  isPurchaseCovering,
} from "../src/modules/offering/application/poll-onramp-transactions.service.js";
import type {
  PendingPurchaseReservationForTimer,
  ReservationRepository,
} from "../src/modules/offering/repository/reservation.repository.js";

const now = new Date("2026-09-02T10:00:00.000Z");
const logger = pino({ level: "silent" });

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
    findPendingPurchaseReservationForTimers: vi.fn().mockResolvedValue(null),
    recordOnrampMoneyEventOnce: vi.fn().mockResolvedValue(true),
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
    const recordOnrampMoneyEventOnce = vi.fn().mockResolvedValue(true);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction()],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampMoneyEventOnce,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(listBuyTransactions).toHaveBeenCalledWith({ partnerUserRef: "reservation_01" });
    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledWith({
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
    const recordOnrampMoneyEventOnce = vi.fn().mockResolvedValue(true);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction({ transactionId: "txn_wrong_asset", purchaseCurrency: "ETH" })],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampMoneyEventOnce,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "reservation_01",
        capitalState: "purchase_failed",
        providerReference: "txn_wrong_asset",
        amountEurc: null,
      }),
    );
  });

  it("records purchase_failed for a success that lands far below the reserved amount", async () => {
    const recordOnrampMoneyEventOnce = vi.fn().mockResolvedValue(true);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction({ transactionId: "txn_underfunded", purchaseAmountValue: "500.000000" })],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampMoneyEventOnce,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        capitalState: "purchase_failed",
        providerReference: "txn_underfunded",
        amountEurc: null,
      }),
    );
  });

  it("records purchase_failed for a zero-value success, not eurc_reserved", async () => {
    const recordOnrampMoneyEventOnce = vi.fn().mockResolvedValue(true);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction({ transactionId: "txn_zero", purchaseAmountValue: "0.000000" })],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampMoneyEventOnce,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "purchase_failed", providerReference: "txn_zero" }),
    );
    expect(recordOnrampMoneyEventOnce).not.toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "eurc_reserved" }),
    );
  });

  it("records purchase_failed only once nothing is still in flight", async () => {
    const recordOnrampMoneyEventOnce = vi.fn().mockResolvedValue(true);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction({ transactionId: "txn_failed", status: "failed" })],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampMoneyEventOnce,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledWith(
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
    const recordOnrampMoneyEventOnce = vi.fn();
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
        recordOnrampMoneyEventOnce,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(recordOnrampMoneyEventOnce).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0, failed: 0 });
  });

  it("prefers a success over an earlier failed attempt on the same reservation", async () => {
    const recordOnrampMoneyEventOnce = vi.fn().mockResolvedValue(true);
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
        recordOnrampMoneyEventOnce,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "eurc_reserved", providerReference: "txn_retry_success" }),
    );
  });

  it("funds from a covering success even when an earlier success does not cover", async () => {
    const recordOnrampMoneyEventOnce = vi.fn().mockResolvedValue(true);
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
        recordOnrampMoneyEventOnce,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledTimes(1);
    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        capitalState: "eurc_reserved",
        providerReference: "txn_covering",
        amountEurc: "960.000000",
      }),
    );
  });

  it("waits for an in-flight retry instead of failing on a non-covering success", async () => {
    const recordOnrampMoneyEventOnce = vi.fn();
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
        recordOnrampMoneyEventOnce,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(recordOnrampMoneyEventOnce).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0, failed: 0 });
  });

  it("follows the page cursor and funds from a covering success on page 2", async () => {
    const recordOnrampMoneyEventOnce = vi.fn().mockResolvedValue(true);
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
        recordOnrampMoneyEventOnce,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(listBuyTransactions).toHaveBeenNthCalledWith(1, { partnerUserRef: "reservation_01" });
    expect(listBuyTransactions).toHaveBeenNthCalledWith(2, { partnerUserRef: "reservation_01", pageKey: "page_2" });
    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledTimes(1);
    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "eurc_reserved", providerReference: "txn_page2_covering" }),
    );
  });

  it("stops at the page cap and records nothing when no covering success was seen", async () => {
    const recordOnrampMoneyEventOnce = vi.fn();
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
        recordOnrampMoneyEventOnce,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(listBuyTransactions).toHaveBeenCalledTimes(MAX_ONRAMP_TRANSACTION_PAGES);
    expect(recordOnrampMoneyEventOnce).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0, failed: 0 });
  });

  it("still funds from a covering success seen before the page cap", async () => {
    const recordOnrampMoneyEventOnce = vi.fn().mockResolvedValue(true);
    const listBuyTransactions = vi
      .fn()
      .mockResolvedValueOnce({ transactions: [transaction({ transactionId: "txn_covering" })], nextPageKey: "page_2" })
      .mockResolvedValue({ transactions: [], nextPageKey: "page_n" });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordOnrampMoneyEventOnce,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(listBuyTransactions).toHaveBeenCalledTimes(MAX_ONRAMP_TRANSACTION_PAGES);
    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "eurc_reserved", providerReference: "txn_covering" }),
    );
  });

  it("keeps polling the other reservations when one lookup fails, then fails the run with its counts", async () => {
    const recordOnrampMoneyEventOnce = vi.fn().mockResolvedValue(true);
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
        recordOnrampMoneyEventOnce,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const run = service.execute("trace_01");

    await expect(run).rejects.toBeInstanceOf(OnrampPollIncompleteError);
    await expect(run).rejects.toMatchObject({ summary: { checked: 3, acted: 2, failed: 1 } });
    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledTimes(2);
    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "reservation_a", capitalState: "eurc_reserved" }),
    );
    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "reservation_b", capitalState: "eurc_reserved" }),
    );
  });

  it("isolates a failed money-event write the same way as a failed lookup", async () => {
    const recordOnrampMoneyEventOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(true);
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi
          .fn()
          .mockResolvedValue([pending({ reservationId: "reservation_a" }), pending({ reservationId: "reservation_b" })]),
        recordOnrampMoneyEventOnce,
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
    expect(recordOnrampMoneyEventOnce).toHaveBeenCalledTimes(2);
  });

  it("does nothing when no transaction exists yet for the reservation", async () => {
    const recordOnrampMoneyEventOnce = vi.fn();
    const service = new PollOnrampTransactionsService(
      repository({ listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]) }),
      coinbase(),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(recordOnrampMoneyEventOnce).not.toHaveBeenCalled();
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
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type {
  CoinbaseCdpClient,
  OnrampTransactionSummary,
} from "../src/modules/offering/application/coinbase-cdp-client.js";
import {
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
    recordMoneyEvent: vi.fn().mockResolvedValue(undefined),
    listInitiatedReservationsForTimers: vi.fn().mockResolvedValue([]),
    expireReservation: vi.fn(),
    listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([]),
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
    const recordMoneyEvent = vi.fn().mockResolvedValue(undefined);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction()],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordMoneyEvent,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(listBuyTransactions).toHaveBeenCalledWith({ partnerUserRef: "reservation_01" });
    expect(recordMoneyEvent).toHaveBeenCalledWith({
      reservationId: "reservation_01",
      provider: "coinbase_cdp",
      providerReference: "txn_01",
      capitalState: "eurc_reserved",
      amountEur: "1000.00",
      amountEurc: "950.000000",
      recordedAt: now,
    });
    expect(summary).toEqual({ checked: 1, acted: 1 });
  });

  it("records purchase_failed for a success that does not cover the reservation (wrong asset)", async () => {
    const recordMoneyEvent = vi.fn().mockResolvedValue(undefined);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction({ transactionId: "txn_wrong_asset", purchaseCurrency: "ETH" })],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordMoneyEvent,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordMoneyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "reservation_01",
        capitalState: "purchase_failed",
        providerReference: "txn_wrong_asset",
        amountEurc: null,
      }),
    );
  });

  it("records purchase_failed for a success that lands far below the reserved amount", async () => {
    const recordMoneyEvent = vi.fn().mockResolvedValue(undefined);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction({ transactionId: "txn_underfunded", purchaseAmountValue: "500.000000" })],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordMoneyEvent,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordMoneyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        capitalState: "purchase_failed",
        providerReference: "txn_underfunded",
        amountEurc: null,
      }),
    );
  });

  it("records purchase_failed for a zero-value success, not eurc_reserved", async () => {
    const recordMoneyEvent = vi.fn().mockResolvedValue(undefined);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction({ transactionId: "txn_zero", purchaseAmountValue: "0.000000" })],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordMoneyEvent,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordMoneyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "purchase_failed", providerReference: "txn_zero" }),
    );
    expect(recordMoneyEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "eurc_reserved" }),
    );
  });

  it("records purchase_failed only once nothing is still in flight", async () => {
    const recordMoneyEvent = vi.fn().mockResolvedValue(undefined);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: [transaction({ transactionId: "txn_failed", status: "failed" })],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({
        listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]),
        recordMoneyEvent,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(recordMoneyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "reservation_01",
        capitalState: "purchase_failed",
        providerReference: "txn_failed",
        amountEurc: null,
      }),
    );
    expect(summary).toEqual({ checked: 1, acted: 1 });
  });

  it("leaves capital_state alone while a transaction is still in flight, even alongside a failed attempt", async () => {
    const recordMoneyEvent = vi.fn();
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
        recordMoneyEvent,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(recordMoneyEvent).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  it("prefers a success over an earlier failed attempt on the same reservation", async () => {
    const recordMoneyEvent = vi.fn().mockResolvedValue(undefined);
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
        recordMoneyEvent,
      }),
      coinbase({ listBuyTransactions }),
      logger,
      () => now,
    );

    await service.execute("trace_01");

    expect(recordMoneyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "eurc_reserved", providerReference: "txn_retry_success" }),
    );
  });

  it("does nothing when no transaction exists yet for the reservation", async () => {
    const recordMoneyEvent = vi.fn();
    const service = new PollOnrampTransactionsService(
      repository({ listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]) }),
      coinbase(),
      logger,
      () => now,
    );

    const summary = await service.execute("trace_01");

    expect(recordMoneyEvent).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
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
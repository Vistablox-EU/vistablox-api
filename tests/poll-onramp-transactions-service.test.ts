import { describe, expect, it, vi } from "vitest";

import type {
  CoinbaseCdpClient,
  OnrampTransactionSummary,
} from "../src/modules/offering/application/coinbase-cdp-client.js";
import { PollOnrampTransactionsService } from "../src/modules/offering/application/poll-onramp-transactions.service.js";
import type {
  PendingPurchaseReservationForTimer,
  ReservationRepository,
} from "../src/modules/offering/repository/reservation.repository.js";

const now = new Date("2026-09-02T10:00:00.000Z");

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
  it("advances a successful purchase to eurc_reserved", async () => {
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
      () => now,
    );

    const summary = await service.execute();

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
      () => now,
    );

    const summary = await service.execute();

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
      () => now,
    );

    const summary = await service.execute();

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
      () => now,
    );

    await service.execute();

    expect(recordMoneyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ capitalState: "eurc_reserved", providerReference: "txn_retry_success" }),
    );
  });

  it("does nothing when no transaction exists yet for the reservation", async () => {
    const recordMoneyEvent = vi.fn();
    const service = new PollOnrampTransactionsService(
      repository({ listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([pending()]) }),
      coinbase(),
      () => now,
    );

    const summary = await service.execute();

    expect(recordMoneyEvent).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });
});

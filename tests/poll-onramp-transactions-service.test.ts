import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type {
  CoinbaseCdpClient,
  OnrampTransactionSummary,
} from "../src/modules/offering/application/coinbase-cdp-client.js";
import {
  LATE_PAYMENT_ALERT_EVENTS,
  PollOnrampTransactionsService,
  isPurchaseCovering,
} from "../src/modules/offering/application/poll-onramp-transactions.service.js";
import { LATE_PAYMENT_WATCH_WINDOW_MS } from "../src/modules/offering/domain/late-payment.policy.js";
import type {
  LatePaymentWatchReservation,
  OnrampPaymentRepository,
  RecordOnrampOutcomeResult,
} from "../src/modules/offering/repository/onramp-payment.repository.js";
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

function lapsed(overrides: Partial<LatePaymentWatchReservation> = {}): LatePaymentWatchReservation {
  return { ...pending(), reservationStage: "lapsed", ...overrides };
}

const recorded: RecordOnrampOutcomeResult = { kind: "money_event_recorded", capitalState: "eurc_reserved" };

function payments(overrides: Partial<OnrampPaymentRepository> = {}): OnrampPaymentRepository {
  return {
    recordOnrampOutcome: vi.fn().mockResolvedValue(recorded),
    listLatePaymentWatchReservations: vi.fn().mockResolvedValue([]),
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
  function build(options: {
    pending?: PendingPurchaseReservationForTimer[];
    lateWatch?: LatePaymentWatchReservation[];
    transactions?: OnrampTransactionSummary[];
    result?: RecordOnrampOutcomeResult;
    log?: pino.Logger;
  }) {
    const recordOnrampOutcome = vi.fn().mockResolvedValue(options.result ?? recorded);
    const listLatePaymentWatchReservations = vi.fn().mockResolvedValue(options.lateWatch ?? []);
    const listBuyTransactions = vi.fn().mockResolvedValue({
      transactions: options.transactions ?? [],
      nextPageKey: null,
    });
    const service = new PollOnrampTransactionsService(
      repository({ listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue(options.pending ?? []) }),
      payments({ recordOnrampOutcome, listLatePaymentWatchReservations }),
      coinbase({ listBuyTransactions }),
      options.log ?? logger,
      () => now,
    );
    return { service, recordOnrampOutcome, listLatePaymentWatchReservations, listBuyTransactions };
  }

  it("records a successful purchase that covers the reservation as funded", async () => {
    const { service, recordOnrampOutcome, listBuyTransactions } = build({
      pending: [pending()],
      transactions: [transaction()],
    });

    const summary = await service.execute("trace_01");

    expect(listBuyTransactions).toHaveBeenCalledWith({ partnerUserRef: "reservation_01" });
    expect(recordOnrampOutcome).toHaveBeenCalledWith({
      reservationId: "reservation_01",
      provider: "coinbase_cdp",
      providerReference: "txn_01",
      outcome: "funded",
      amountEur: "1000.00",
      purchaseCurrency: "EURC",
      purchaseAmount: "950.000000",
      recordedAt: now,
      traceId: "trace_01",
    });
    expect(summary).toEqual({ checked: 1, acted: 1 });
  });

  it("records a success that does not cover the reservation (wrong asset) as uncovered", async () => {
    const { service, recordOnrampOutcome } = build({
      pending: [pending()],
      transactions: [transaction({ transactionId: "txn_wrong_asset", purchaseCurrency: "ETH" })],
      result: { kind: "money_event_recorded", capitalState: "purchase_failed" },
    });

    await service.execute("trace_01");

    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "uncovered_success", providerReference: "txn_wrong_asset" }),
    );
  });

  it("records a success that lands far below the reserved amount as uncovered", async () => {
    const { service, recordOnrampOutcome } = build({
      pending: [pending()],
      transactions: [transaction({ transactionId: "txn_underfunded", purchaseAmountValue: "500.000000" })],
    });

    await service.execute("trace_01");

    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "uncovered_success", providerReference: "txn_underfunded" }),
    );
  });

  it("records a zero-value success as uncovered, not funded", async () => {
    const { service, recordOnrampOutcome } = build({
      pending: [pending()],
      transactions: [transaction({ transactionId: "txn_zero", purchaseAmountValue: "0.000000" })],
    });

    await service.execute("trace_01");

    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "uncovered_success", providerReference: "txn_zero" }),
    );
  });

  it("records a failure only once nothing is still in flight", async () => {
    const { service, recordOnrampOutcome } = build({
      pending: [pending()],
      transactions: [transaction({ transactionId: "txn_failed", status: "failed" })],
      result: { kind: "money_event_recorded", capitalState: "purchase_failed" },
    });

    const summary = await service.execute("trace_01");

    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "reservation_01", outcome: "failed", providerReference: "txn_failed" }),
    );
    expect(summary).toEqual({ checked: 1, acted: 1 });
  });

  it("leaves capital_state alone while a transaction is still in flight, even alongside a failed attempt", async () => {
    const { service, recordOnrampOutcome } = build({
      pending: [pending()],
      transactions: [
        transaction({ transactionId: "txn_retry_failed", status: "failed" }),
        transaction({ transactionId: "txn_retry_active", status: "in_progress" }),
      ],
    });

    const summary = await service.execute("trace_01");

    expect(recordOnrampOutcome).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  it("prefers a success over an earlier failed attempt on the same reservation", async () => {
    const { service, recordOnrampOutcome } = build({
      pending: [pending()],
      transactions: [
        transaction({ transactionId: "txn_first_failed", status: "failed" }),
        transaction({ transactionId: "txn_retry_success", status: "success" }),
      ],
    });

    await service.execute("trace_01");

    expect(recordOnrampOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "funded", providerReference: "txn_retry_success" }),
    );
  });

  it("does nothing when no transaction exists yet for the reservation", async () => {
    const { service, recordOnrampOutcome } = build({ pending: [pending()] });

    const summary = await service.execute("trace_01");

    expect(recordOnrampOutcome).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  describe("late payments (issue #168)", () => {
    function capturingLogger() {
      const lines: Array<Record<string, unknown>> = [];
      const log = pino(
        { level: "info" },
        { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
      );
      return { log, lines };
    }

    it("watches lapsed reservations created inside the watch window", async () => {
      const { service, listLatePaymentWatchReservations } = build({});

      await service.execute("trace_01");

      expect(listLatePaymentWatchReservations).toHaveBeenCalledWith({
        since: new Date(now.getTime() - LATE_PAYMENT_WATCH_WINDOW_MS),
      });
    });

    it("holds a success on a lapsed reservation and raises one operator alert", async () => {
      const { log, lines } = capturingLogger();
      const { service, recordOnrampOutcome } = build({
        lateWatch: [lapsed()],
        transactions: [transaction({ transactionId: "txn_late" })],
        result: { kind: "late_payment_held", latePaymentId: "late_payment_01", newlyHeld: true, reservationStage: "lapsed" },
        log,
      });

      const summary = await service.execute("trace_01");

      expect(recordOnrampOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ reservationId: "reservation_01", outcome: "funded", providerReference: "txn_late" }),
      );
      expect(summary).toEqual({ checked: 1, acted: 1 });
      const alerts = lines.filter((line) => line.event === LATE_PAYMENT_ALERT_EVENTS.held);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        event: "offering.late_payment_held",
        severity: "error",
        level: 50,
        trace_id: "trace_01",
        late_payment_id: "late_payment_01",
        reservation_id: "reservation_01",
        reservation_stage: "lapsed",
        covers_reservation: true,
        reserved_amount_eur: "1000.00",
        purchase_currency: "EURC",
        purchase_amount_value: "950.000000",
        provider_reference: "txn_late",
      });
    });

    it("holds an uncovered late success too, flagged as not covering the reservation", async () => {
      const { log, lines } = capturingLogger();
      const { service, recordOnrampOutcome } = build({
        lateWatch: [lapsed()],
        transactions: [transaction({ transactionId: "txn_late_small", purchaseAmountValue: "10.000000" })],
        result: { kind: "late_payment_held", latePaymentId: "late_payment_02", newlyHeld: true, reservationStage: "lapsed" },
        log,
      });

      await service.execute("trace_01");

      expect(recordOnrampOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: "uncovered_success" }));
      expect(lines.find((line) => line.event === LATE_PAYMENT_ALERT_EVENTS.held)).toMatchObject({
        covers_reservation: false,
      });
    });

    it("alerts on a late payment the poll's own listing thought was still initiated", async () => {
      const { log, lines } = capturingLogger();
      const { service } = build({
        pending: [pending()],
        transactions: [transaction()],
        result: { kind: "late_payment_held", latePaymentId: "late_payment_03", newlyHeld: true, reservationStage: "lapsed" },
        log,
      });

      await service.execute("trace_01");

      expect(lines.filter((line) => line.event === LATE_PAYMENT_ALERT_EVENTS.held)).toHaveLength(1);
    });

    it("does not alert again for a late payment that is already held", async () => {
      const { log, lines } = capturingLogger();
      const { service } = build({
        lateWatch: [lapsed()],
        transactions: [transaction()],
        result: { kind: "late_payment_held", latePaymentId: "late_payment_01", newlyHeld: false, reservationStage: "lapsed" },
        log,
      });

      await service.execute("trace_01");

      expect(lines.filter((line) => line.event === LATE_PAYMENT_ALERT_EVENTS.held)).toHaveLength(0);
    });

    it("ignores a failed or still-pending purchase on a lapsed reservation", async () => {
      for (const status of ["failed", "in_progress"] as const) {
        const { service, recordOnrampOutcome } = build({
          lateWatch: [lapsed()],
          transactions: [transaction({ status })],
        });

        const summary = await service.execute("trace_01");

        expect(recordOnrampOutcome).not.toHaveBeenCalled();
        expect(summary).toEqual({ checked: 1, acted: 0 });
      }
    });

    it("does not count an ignored outcome as acted", async () => {
      const { service } = build({
        pending: [pending()],
        transactions: [transaction({ status: "failed" })],
        result: { kind: "ignored", reservationStage: "cancelled" },
      });

      expect(await service.execute("trace_01")).toEqual({ checked: 1, acted: 0 });
    });
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
import type { Logger } from "pino";

import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import { toEurcMicros } from "../domain/currency.js";
import type { CoinbaseCdpClient, OnrampTransactionSummary } from "./coinbase-cdp-client.js";
import type {
  PendingPurchaseReservationForTimer,
  ReservationRepository,
} from "../repository/reservation.repository.js";

type TransactionOutcome =
  | { status: "success" | "failed"; transaction: OnrampTransactionSummary }
  | { status: "pending" };

/**
 * The reconciliation backstop for onramp funding, and the one place that
 * turns Coinbase's transaction list into a money event. Each minute it asks
 * CDP's Transaction Status API about every reservation still waiting on a
 * purchase (eurc_purchase_pending, or purchase_failed after a retry). The
 * signed CDP webhook (ReconcileOnrampWebhookService, see
 * docs/coinbase-cdp-onramp.md) only triggers reconcileReservation early for
 * one reservation; it never trusts the webhook body's status or amounts, so
 * both paths resolve, check coverage and record identically, through
 * recordOnrampMoneyEventOnce's locked, idempotent write.
 * partnerUserRef was set to the reservation ID at session-token creation
 * (CreateReservationService), so one lookup per reservation resolves
 * unambiguously; pagination is not implemented since one reservation only
 * ever has the single onramp session token this repo creates for it, plus
 * at most a couple of abandoned/retried attempts.
 */
export class PollOnrampTransactionsService {
  public constructor(
    private readonly reservations: ReservationRepository,
    private readonly coinbase: CoinbaseCdpClient,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(traceId: string): Promise<JobRunSummary> {
    const pending = await this.reservations.listPendingPurchaseReservationsForTimers();

    let acted = 0;
    for (const reservation of pending) {
      if (await this.reconcileReservation(reservation, traceId)) acted += 1;
    }
    return { checked: pending.length, acted };
  }

  /** Returns true when a money event was recorded; false while still pending or when the outcome was already recorded. */
  public async reconcileReservation(
    reservation: PendingPurchaseReservationForTimer,
    traceId: string,
  ): Promise<boolean> {
    const { transactions } = await this.coinbase.listBuyTransactions({
      partnerUserRef: reservation.reservationId,
    });
    const outcome = resolveOutcome(transactions);
    if (outcome.status === "pending") return false;

    const funded =
      outcome.status === "success" && isPurchaseCovering(outcome.transaction, reservation.amountEur);
    const recorded = await this.reservations.recordOnrampMoneyEventOnce({
      reservationId: reservation.reservationId,
      provider: "coinbase_cdp",
      providerReference: outcome.transaction.transactionId,
      capitalState: funded ? "eurc_reserved" : "purchase_failed",
      amountEur: reservation.amountEur,
      amountEurc: funded ? outcome.transaction.purchaseAmountValue : null,
      recordedAt: this.clock(),
    });
    if (recorded && outcome.status === "success" && !funded) {
      this.logger.warn(
        {
          trace_id: traceId,
          reservation_id: reservation.reservationId,
          reserved_amount_eur: reservation.amountEur,
          purchase_currency: outcome.transaction.purchaseCurrency,
          purchase_amount_value: outcome.transaction.purchaseAmountValue,
          payment_total_currency: outcome.transaction.paymentTotalCurrency,
          payment_total_value: outcome.transaction.paymentTotalValue,
          provider_reference: outcome.transaction.transactionId,
        },
        "onramp success does not cover the reserved amount; recorded purchase_failed",
      );
    }
    return recorded;
  }
}

/**
 * Is the credited EURC enough to cover the reserved EUR? EURC is EUR-pegged
 * 1:1, but the onramp's fee is paid out of the credited amount, so a normal
 * purchase lands a few percent short — accept a 90% tolerance band rather
 * than demanding a full 1:1. A success outside that band (a different
 * purchased asset, a near-empty purchase, or an amount far below the
 * reservation) is real money arriving for the wrong thing, and must never
 * look like the funding this reservation is waiting on.
 */
export function isPurchaseCovering(transaction: OnrampTransactionSummary, reservedAmountEur: string): boolean {
  if (transaction.purchaseCurrency !== "EURC") return false;
  const creditedMicros = toEurcMicros(transaction.purchaseAmountValue);
  const minimumMicros = (toEurcMicros(reservedAmountEur) * 9n) / 10n;
  return creditedMicros > 0n && creditedMicros >= minimumMicros;
}

function resolveOutcome(transactions: OnrampTransactionSummary[]): TransactionOutcome {
  const success = transactions.find((transaction) => transaction.status === "success");
  if (success !== undefined) return { status: "success", transaction: success };

  const stillInFlight = transactions.some(
    (transaction) => transaction.status === "created" || transaction.status === "in_progress",
  );
  if (stillInFlight) return { status: "pending" };

  const failed = transactions.find((transaction) => transaction.status === "failed");
  if (failed !== undefined) return { status: "failed", transaction: failed };

  return { status: "pending" };
}

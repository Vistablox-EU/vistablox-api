import type { Logger } from "pino";

import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import { toEurcMicros } from "../domain/currency.js";
import type { CoinbaseCdpClient, OnrampTransactionSummary } from "./coinbase-cdp-client.js";
import {
  LoggingOtherStageOnrampOutcomeHandler,
  type OtherStageOnrampOutcomeHandler,
} from "./other-stage-onramp-outcome.js";
import type {
  OnrampOutcomeRecording,
  ReservationRepository,
} from "../repository/reservation.repository.js";

/**
 * Upper bound on transaction pages fetched per reservation per run. One
 * reservation normally has a single onramp session plus at most a few
 * abandoned or retried attempts, so this is far above real use; it exists so
 * a provider that keeps returning a page cursor cannot hold the run forever.
 */
export const MAX_ONRAMP_TRANSACTION_PAGES = 10;

type TransactionOutcome =
  | { status: "funded" | "uncovered_success" | "failed"; transaction: OnrampTransactionSummary }
  | { status: "pending" };

export interface PollOnrampTransactionsSummary extends JobRunSummary {
  failed: number;
}

/** What reconcileReservation needs to know about a reservation: both the poll's list and the webhook job's lookup satisfy it. */
export interface OnrampReconcileTarget {
  reservationId: string;
  amountEur: string;
}

/**
 * What reconciling one reservation concluded. "unresolved": Coinbase has not
 * reached a conclusion yet (nothing started, an attempt still in flight, or
 * pages unread past the cap), so nothing was recorded. "resolved": it did,
 * and `recording` is the single recording method's answer; only
 * `recording.status === "recorded"` wrote a money event.
 */
export type OnrampReconcileResult =
  | { status: "unresolved" }
  | {
      status: "resolved";
      capitalState: "eurc_reserved" | "purchase_failed";
      providerTransactionId: string;
      recording: OnrampOutcomeRecording;
    };

/** Thrown only after every reservation was tried; `summary` carries the run's counts for the job log. */
export class OnrampPollIncompleteError extends Error {
  public constructor(public readonly summary: PollOnrampTransactionsSummary) {
    super(
      `Onramp poll could not check ${summary.failed} of ${summary.checked} reservations (acted on ${summary.acted}).`,
    );
    this.name = "OnrampPollIncompleteError";
  }
}

/**
 * The reconciliation backstop for onramp funding, and the one place that
 * turns Coinbase's transaction list into a money event. Each minute it asks
 * CDP's Transaction Status API about every reservation still waiting on a
 * purchase (eurc_purchase_pending, or purchase_failed after a retry). The
 * signed CDP webhook (ReconcileOnrampWebhookService, AD-289) calls
 * reconcileReservation early for one reservation and never trusts the
 * webhook body's status or amounts, so both paths resolve, check coverage and
 * record identically, through the one recording method
 * (ReservationRepository.recordOnrampOutcome: lock, latest event, funded
 * guard, dedupe per provider transaction and state, stage check). Both
 * honour what it returns: only a "recorded" outcome counts as acted on, and
 * an other_stage outcome goes to the late-evidence seam.
 * partnerUserRef was set to the reservation ID at session-token creation
 * (CreateReservationService), so one lookup per reservation resolves
 * unambiguously. The lookup follows the provider's page cursor (up to
 * MAX_ONRAMP_TRANSACTION_PAGES) so a covering transaction on a later page is
 * never missed.
 *
 * Each reservation is polled in isolation: a failed lookup or write is
 * logged and counted, and the run moves on to the next reservation. Only
 * after every reservation has been tried does a run with failures throw, so
 * pg-boss retries it and a persistent failure still reaches the dead-letter
 * queue.
 */
export class PollOnrampTransactionsService {
  public constructor(
    private readonly reservations: ReservationRepository,
    private readonly coinbase: CoinbaseCdpClient,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
    private readonly otherStageOutcomes: OtherStageOnrampOutcomeHandler = new LoggingOtherStageOnrampOutcomeHandler(
      logger,
    ),
  ) {}

  public async execute(traceId: string): Promise<PollOnrampTransactionsSummary> {
    const pending = await this.reservations.listPendingPurchaseReservationsForTimers();

    let acted = 0;
    let failed = 0;
    for (const reservation of pending) {
      try {
        const result = await this.reconcileReservation(reservation, traceId);
        if (result.status === "resolved" && result.recording.status === "recorded") acted += 1;
      } catch (error) {
        failed += 1;
        this.logger.error(
          { err: error, trace_id: traceId, reservation_id: reservation.reservationId },
          "onramp poll failed for reservation; continuing with the rest",
        );
      }
    }

    const summary = { checked: pending.length, acted, failed };
    if (failed > 0) {
      throw new OnrampPollIncompleteError(summary);
    }
    return summary;
  }

  /**
   * Resolves one reservation's outcome from Coinbase and records it through
   * the single recording method. Used by the poll's loop and by the webhook
   * job, so neither can record differently from the other.
   */
  public async reconcileReservation(
    reservation: OnrampReconcileTarget,
    traceId: string,
  ): Promise<OnrampReconcileResult> {
    const { transactions, complete } = await this.listAllTransactions(reservation.reservationId);
    if (!complete) {
      this.logger.warn(
        {
          trace_id: traceId,
          reservation_id: reservation.reservationId,
          pages_fetched: MAX_ONRAMP_TRANSACTION_PAGES,
          transactions_seen: transactions.length,
        },
        "onramp transaction list exceeded the page cap; only a covering success seen so far can be acted on",
      );
    }

    const outcome = resolveOutcome(transactions, reservation.amountEur, complete);
    if (outcome.status === "pending") return { status: "unresolved" };

    const funded = outcome.status === "funded";
    const capitalState = funded ? "eurc_reserved" : "purchase_failed";
    const observedAt = this.clock();
    const recording = await this.reservations.recordOnrampOutcome({
      reservationId: reservation.reservationId,
      provider: "coinbase_cdp",
      providerReference: outcome.transaction.transactionId,
      capitalState,
      amountEur: reservation.amountEur,
      amountEurc: funded ? outcome.transaction.purchaseAmountValue : null,
      recordedAt: observedAt,
    });

    switch (recording.status) {
      case "recorded":
        // Only a row that was actually written is worth a warning: a
        // purchase_failed reservation stays in the poll list, so this would
        // otherwise repeat every minute for the same transaction.
        if (outcome.status === "uncovered_success") {
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
        break;
      case "other_stage":
        // The recording method wrote nothing: the reservation has left
        // 'initiated'. The one transaction it was asked about (the first
        // covering success, else the first success, else the failed attempt)
        // goes to the late-evidence seam, which is idempotent on its id and
        // lists a success only.
        await this.otherStageOutcomes.handleOtherStageOutcome({
          reservationId: reservation.reservationId,
          reservationStage: recording.reservationStage,
          latestCapitalState: recording.latestCapitalState,
          providerTransactionId: outcome.transaction.transactionId,
          txHash: outcome.transaction.txHash,
          destinationWallet: outcome.transaction.walletAddress,
          amount: outcome.transaction.purchaseAmountValue,
          asset: outcome.transaction.purchaseCurrency,
          state: capitalState,
          transactionSucceeded: outcome.status !== "failed",
          observedAt,
          traceId,
        });
        break;
      case "duplicate":
        // Expected every minute for a purchase_failed reservation.
        this.logger.debug(
          {
            trace_id: traceId,
            reservation_id: reservation.reservationId,
            provider_reference: outcome.transaction.transactionId,
            capital_state: capitalState,
          },
          "onramp outcome already recorded; nothing to write",
        );
        break;
      case "already_funded":
      case "not_awaiting_purchase":
      case "unknown_reservation":
        this.logger.info(
          {
            trace_id: traceId,
            reservation_id: reservation.reservationId,
            provider_reference: outcome.transaction.transactionId,
            capital_state: capitalState,
            recording: recording.status,
          },
          "onramp outcome not recorded: the reservation is not awaiting this purchase",
        );
        break;
    }
    return {
      status: "resolved",
      capitalState,
      providerTransactionId: outcome.transaction.transactionId,
      recording,
    };
  }

  private async listAllTransactions(
    partnerUserRef: string,
  ): Promise<{ transactions: OnrampTransactionSummary[]; complete: boolean }> {
    const transactions: OnrampTransactionSummary[] = [];
    let pageKey: string | undefined;
    for (let page = 0; page < MAX_ONRAMP_TRANSACTION_PAGES; page += 1) {
      const result = await this.coinbase.listBuyTransactions(
        pageKey === undefined ? { partnerUserRef } : { partnerUserRef, pageKey },
      );
      transactions.push(...result.transactions);
      if (result.nextPageKey === null || result.nextPageKey === "") {
        return { transactions, complete: true };
      }
      pageKey = result.nextPageKey;
    }
    return { transactions, complete: false };
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

/**
 * Any covering success funds the reservation, wherever it sits in the list.
 * Without one, nothing is concluded while an attempt is still in flight or
 * while pages remain unread, since either could still hold the covering
 * success. Only then does a non-covering success, or else a failure, close
 * the attempt as purchase_failed.
 */
function resolveOutcome(
  transactions: OnrampTransactionSummary[],
  reservedAmountEur: string,
  complete: boolean,
): TransactionOutcome {
  const successes = transactions.filter((transaction) => transaction.status === "success");
  const covering = successes.find((transaction) => isPurchaseCovering(transaction, reservedAmountEur));
  if (covering !== undefined) return { status: "funded", transaction: covering };

  if (!complete) return { status: "pending" };

  const stillInFlight = transactions.some(
    (transaction) => transaction.status === "created" || transaction.status === "in_progress",
  );
  if (stillInFlight) return { status: "pending" };

  const uncovered = successes[0];
  if (uncovered !== undefined) return { status: "uncovered_success", transaction: uncovered };

  const failed = transactions.find((transaction) => transaction.status === "failed");
  if (failed !== undefined) return { status: "failed", transaction: failed };

  return { status: "pending" };
}

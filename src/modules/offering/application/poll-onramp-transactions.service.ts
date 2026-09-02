import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import type { CoinbaseCdpClient, OnrampTransactionSummary } from "./coinbase-cdp-client.js";
import type { ReservationRepository } from "../repository/reservation.repository.js";

type TransactionOutcome =
  | { status: "success" | "failed"; transaction: OnrampTransactionSummary }
  | { status: "pending" };

/**
 * Coinbase's onramp/offramp API has no webhook (confirmed against CDP's own
 * API reference, not assumed — see docs/coinbase-cdp-onramp.md) — this is
 * the only way capital_state ever advances past eurc_purchase_pending.
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
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(): Promise<JobRunSummary> {
    const pending = await this.reservations.listPendingPurchaseReservationsForTimers();

    let acted = 0;
    for (const reservation of pending) {
      const { transactions } = await this.coinbase.listBuyTransactions({
        partnerUserRef: reservation.reservationId,
      });
      const outcome = resolveOutcome(transactions);
      if (outcome.status === "pending") continue;

      await this.reservations.recordMoneyEvent({
        reservationId: reservation.reservationId,
        provider: "coinbase_cdp",
        providerReference: outcome.transaction.transactionId,
        capitalState: outcome.status === "success" ? "eurc_reserved" : "purchase_failed",
        amountEur: reservation.amountEur,
        amountEurc: outcome.status === "success" ? outcome.transaction.purchaseAmountValue : null,
        recordedAt: this.clock(),
      });
      acted += 1;
    }
    return { checked: pending.length, acted };
  }
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

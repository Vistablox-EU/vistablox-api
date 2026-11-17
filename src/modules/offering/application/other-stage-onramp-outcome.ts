import type { Logger } from "pino";

import type { OnrampOutcomeCapitalState } from "../domain/onramp-outcome-recording.policy.js";

/**
 * An onramp outcome Coinbase reports for a reservation that is no longer in
 * the 'initiated' stage (lapsed, cancelled, or past funding): the recording
 * method wrote nothing and returned other_stage. Every field the ops
 * visibility list of AD-288 needs is here: provider transaction id, tx hash,
 * destination wallet, reservation id, amount and asset, state, observed_at.
 */
export interface OtherStageOnrampOutcome {
  reservationId: string;
  reservationStage: string;
  latestCapitalState: string | null;
  providerTransactionId: string;
  txHash: string | null;
  destinationWallet: string;
  amount: string;
  asset: string;
  /** What the outcome would have been recorded as on a reservation still awaiting its purchase. */
  state: OnrampOutcomeCapitalState;
  /** True when Coinbase reports this transaction as a success: money moved. A failed attempt moved none. */
  transactionSucceeded: boolean;
  observedAt: Date;
  traceId: string;
}

/**
 * THE SEAM for the late-evidence path (#195, AD-288). Both the minute poll and
 * the webhook job hand an other_stage outcome to this and nothing else; the
 * recording method has already refused to write money for it, so a handler
 * must not revive the reservation, hold the funds or offer a refund (AD-243,
 * AD-251, AD-260 step 9, AD-266). In the worker it is
 * RecordOnrampLateEvidenceService, which writes the ops-visibility entry;
 * LoggingOtherStageOnrampOutcomeHandler below is only the default for a
 * caller that wires none. It runs once per transaction the recording method
 * answered other_stage for: the transaction the list resolves to, and, once
 * the reservation has left 'initiated', every other success of the list (see
 * PollOnrampTransactionsService.reconcileReservation). A webhook retry, a
 * duplicate delivery, or the poll and the webhook both seeing the same
 * transaction reach it again: it must be idempotent on providerTransactionId.
 */
export interface OtherStageOnrampOutcomeHandler {
  handleOtherStageOutcome(outcome: OtherStageOnrampOutcome): Promise<void>;
}

/**
 * The default handler: a warning that carries ids and amounts, and never the
 * destination wallet (a public address, but linkable to an investor, so it
 * stays out of log lines like the webhook body does). It records nothing, so
 * the worker never relies on it (tests/onramp-late-evidence-wiring.test.ts).
 */
export class LoggingOtherStageOnrampOutcomeHandler implements OtherStageOnrampOutcomeHandler {
  public constructor(private readonly logger: Logger) {}

  public handleOtherStageOutcome(outcome: OtherStageOnrampOutcome): Promise<void> {
    this.logger.warn(
      {
        trace_id: outcome.traceId,
        reservation_id: outcome.reservationId,
        reservation_stage: outcome.reservationStage,
        latest_capital_state: outcome.latestCapitalState,
        provider_reference: outcome.providerTransactionId,
        tx_hash: outcome.txHash,
        amount: outcome.amount,
        asset: outcome.asset,
        outcome_state: outcome.state,
        transaction_succeeded: outcome.transactionSucceeded,
        observed_at: outcome.observedAt.toISOString(),
      },
      "onramp outcome for a reservation that is no longer initiated; nothing recorded",
    );
    return Promise.resolve();
  }
}

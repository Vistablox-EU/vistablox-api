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
  observedAt: Date;
  traceId: string;
}

/**
 * THE SEAM for the late-evidence path (#195, AD-288). Both the minute poll and
 * the webhook job hand an other_stage outcome to this and nothing else; the
 * recording method has already refused to write money for it, so a handler
 * must not revive the reservation, hold the funds or offer a refund (AD-243,
 * AD-251, AD-260 step 9, AD-266). #195 replaces the default logging handler
 * with one that writes its ops-visibility entry. It runs once per delivery or
 * poll, so a webhook retry, a duplicate delivery, or the poll and the webhook
 * both seeing the same transaction reach it again: it must be idempotent on
 * providerTransactionId.
 */
export interface OtherStageOnrampOutcomeHandler {
  handleOtherStageOutcome(outcome: OtherStageOnrampOutcome): Promise<void>;
}

/**
 * The handler until #195 lands: a warning that carries ids and amounts, and
 * never the destination wallet (a public address, but linkable to an investor,
 * so it stays out of log lines like the webhook body does).
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
        observed_at: outcome.observedAt.toISOString(),
      },
      "onramp outcome for a reservation that is no longer initiated; nothing recorded",
    );
    return Promise.resolve();
  }
}

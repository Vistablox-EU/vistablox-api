import { isReservationFunded } from "./reservation-eligibility.policy.js";

/**
 * The latest money.money_events.capital_state values an onramp outcome can be
 * recorded from: the reservation is waiting on its purchase
 * (eurc_purchase_pending), or an earlier attempt failed and a retry may still
 * land (purchase_failed). Anything else (no event yet, funded, a state a later
 * stage wrote) is not waiting on Coinbase.
 */
export const ONRAMP_AWAITING_CAPITAL_STATES = ["eurc_purchase_pending", "purchase_failed"] as const;

/** What the poller and the webhook job conclude from Coinbase's transaction list. */
export type OnrampOutcomeCapitalState = "eurc_reserved" | "purchase_failed";

export type OnrampRecordingDecision =
  | "record"
  | "duplicate"
  | "other_stage"
  | "already_funded"
  | "not_awaiting_purchase";

/**
 * The guard matrix of the single onramp recording method
 * (recordOnrampOutcome). The repository takes the reservation row lock, reads
 * the reservation's stage and its latest money event, and asks whether this
 * provider transaction was already recorded in this state; this function is
 * the decision, in the order the checks must run:
 *
 * 1. duplicate: the same provider transaction in the same state is already
 *    recorded for the reservation, at any point in its history, in any stage.
 *    This comes before the stage check so that evidence already on file never
 *    reads as late evidence once the reservation has moved on. It also stops
 *    the poll, which keeps listing a purchase_failed reservation every
 *    minute, from writing the same purchase_failed row again, and stops a
 *    transaction that failed before a retry from failing the retry.
 * 2. other_stage: the reservation is no longer in the 'initiated' stage
 *    (lapsed, cancelled, or past funding). Nothing is written. The caller
 *    hands the outcome to the late-evidence path.
 * 3. already_funded: the latest event is a funded state. Nothing is written:
 *    an unfunded event must never become the latest over funded money (the
 *    expiry sweeper reads the latest event, #201), and a second funded event
 *    for another transaction is not recorded either.
 * 4. not_awaiting_purchase: the latest event is neither eurc_purchase_pending
 *    nor purchase_failed.
 * 5. record.
 */
export function decideOnrampRecording(input: {
  reservationStage: string;
  latestCapitalState: string | null;
  outcomeAlreadyRecorded: boolean;
}): OnrampRecordingDecision {
  if (input.outcomeAlreadyRecorded) return "duplicate";
  if (input.reservationStage !== "initiated") return "other_stage";
  if (isReservationFunded(input.latestCapitalState)) return "already_funded";
  if (
    input.latestCapitalState === null ||
    !(ONRAMP_AWAITING_CAPITAL_STATES as readonly string[]).includes(input.latestCapitalState)
  ) {
    return "not_awaiting_purchase";
  }
  return "record";
}

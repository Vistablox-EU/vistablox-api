import type { OnrampOutcomeCapitalState } from "./onramp-outcome-recording.policy.js";

/**
 * Late onramp evidence (AD-288, decided 2026-11-17; issue #168).
 *
 * The single onramp recording method (recordOnrampOutcome) answers
 * other_stage when Coinbase reports an outcome for a reservation that has left
 * the 'initiated' stage, and writes nothing. For a success that is money
 * which reached the investor's own wallet after the reservation could no
 * longer take it (AD-243: the EURC goes straight to the investor's wallet).
 * Nothing is held, reinstated or refunded (AD-243, AD-251, AD-260 step 9,
 * AD-266): staff only get a list of what was seen, so they know it happened.
 * This file decides what is worth listing, and nothing else.
 */

/**
 * What the outcome would have been recorded as on a reservation still waiting
 * for its purchase: 'eurc_reserved' for a success that covers the reservation
 * (isPurchaseCovering), 'purchase_failed' for a success that does not (a
 * different asset, or below the 90% tolerance band).
 */
export type OnrampLateEvidenceState = OnrampOutcomeCapitalState;

export const ONRAMP_LATE_EVIDENCE_STATES = ["eurc_reserved", "purchase_failed"] as const satisfies readonly OnrampLateEvidenceState[];

/**
 * Why an entry is on the list, derived from the reservation's stage when it
 * was seen. The stage is stored; this is only how it reads to staff.
 *
 * - reservation_lapsed: the 15-minute expiry (or the finalization sweep)
 *   lapsed it before the purchase completed.
 * - reservation_cancelled: staff or an intake-case closure cancelled it.
 * - reservation_funded_already: it is in a stage only a funded reservation
 *   reaches (awaiting_reconfirmation, reconfirmed, finalized), so this is a
 *   further payment on top of the funding already recorded.
 * - reservation_other_stage: any stage this code does not know. A stage added
 *   later must still show up here rather than vanish, so unknown is listed.
 */
export type OnrampLateEvidenceReason =
  | "reservation_lapsed"
  | "reservation_cancelled"
  | "reservation_funded_already"
  | "reservation_other_stage";

const FUNDED_ALREADY_STAGES: readonly string[] = ["awaiting_reconfirmation", "reconfirmed", "finalized"];

/**
 * Does an outcome the recording method refused (other_stage) belong on the
 * list, and why?
 *
 * Only a success is listed: a failed purchase moved no money, so there is
 * nothing for anyone to look at. A reservation still in 'initiated' is not
 * late at all (the recording method never answers other_stage for it), so it
 * is never listed here either. Returns null for both.
 */
export function classifyLateOnrampEvidence(input: {
  reservationStage: string;
  transactionSucceeded: boolean;
}): OnrampLateEvidenceReason | null {
  if (!input.transactionSucceeded) return null;
  if (input.reservationStage === "initiated") return null;
  if (input.reservationStage === "lapsed") return "reservation_lapsed";
  if (input.reservationStage === "cancelled") return "reservation_cancelled";
  if (FUNDED_ALREADY_STAGES.includes(input.reservationStage)) return "reservation_funded_already";
  return "reservation_other_stage";
}

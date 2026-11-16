/**
 * Issue #168. A provider payment that completes after its reservation has
 * left 'initiated' (lapsed by the 15-minute expiry, or cancelled) is a late
 * payment. Phase-1 policy is manual review: the payment is held in
 * money.late_payments for staff, never written to money_events, never used to
 * reinstate the reservation and never refunded automatically. Reinstating or
 * refunding is an open founder decision (docs/investor-offering.md).
 */

/**
 * How long after a reservation was created the onramp poll keeps watching it
 * for a late payment once it is no longer 'initiated'. Card payments settle
 * in minutes, but a bank transfer can take several business days, so this
 * covers a SEPA transfer started just before a long weekend. Tunable: past
 * the window a late payment is only found by reconciling against Coinbase.
 */
export const LATE_PAYMENT_WATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const LATE_PAYMENT_REVIEW_STATUSES = ["pending_review"] as const;
export type LatePaymentReviewStatus = (typeof LATE_PAYMENT_REVIEW_STATUSES)[number];

/** Reservations created at or after this instant are still watched for a late payment. */
export function latePaymentWatchSince(now: Date): Date {
  return new Date(now.getTime() - LATE_PAYMENT_WATCH_WINDOW_MS);
}

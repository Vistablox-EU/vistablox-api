import type { LatePaymentReviewStatus } from "../domain/late-payment.policy.js";

/**
 * What the onramp poll learned about one reservation's provider transaction.
 * - `funded`: a success that covers the reserved amount.
 * - `uncovered_success`: a success for the wrong asset or far too little.
 * - `failed`: the provider reports the purchase failed.
 */
export type OnrampOutcome = "funded" | "uncovered_success" | "failed";

export interface RecordOnrampOutcomeInput {
  reservationId: string;
  provider: string;
  providerReference: string;
  outcome: OnrampOutcome;
  /** The reservation's own amount_eur, as the poll listed it. */
  amountEur: string;
  purchaseCurrency: string;
  purchaseAmount: string;
  recordedAt: Date;
  traceId: string;
}

export type RecordOnrampOutcomeResult =
  /** The reservation was still 'initiated': a money event was appended exactly as before. */
  | { kind: "money_event_recorded"; capitalState: "eurc_reserved" | "purchase_failed" }
  /** The reservation had already left 'initiated' and money arrived: held for manual review. `newlyHeld` is false on a re-poll of the same provider transaction. */
  | { kind: "late_payment_held"; latePaymentId: string; newlyHeld: boolean; reservationStage: string }
  /** Nothing to record: a failed purchase on a reservation that is no longer 'initiated', or the reservation no longer exists. */
  | { kind: "ignored"; reservationStage: string | null };

export interface LatePaymentWatchReservation {
  reservationId: string;
  accountId: string;
  amountEur: string;
  reservationStage: string;
}

/**
 * Writes for the onramp poll. recordOnrampOutcome takes the reservation row
 * lock (the same FOR UPDATE ExpireUnfundedReservationsService takes) and reads
 * the stage under it, so a payment is classified as on-time or late against
 * the stage the expiry actually committed, never a stale listing snapshot.
 */
export interface OnrampPaymentRepository {
  recordOnrampOutcome(input: RecordOnrampOutcomeInput): Promise<RecordOnrampOutcomeResult>;
  /** Lapsed or cancelled reservations created at or after `since` whose purchase was still pending or failed, with no late payment held for them yet. */
  listLatePaymentWatchReservations(input: { since: Date }): Promise<LatePaymentWatchReservation[]>;
}

export interface LatePaymentRecord {
  latePaymentId: string;
  reservationId: string;
  offeringId: string;
  accountId: string;
  provider: string;
  providerReference: string;
  reservationStageAtDetection: string;
  currentReservationStage: string;
  reservedAmountEur: string;
  purchaseCurrency: string;
  purchaseAmount: string;
  coversReservation: boolean;
  reviewStatus: string;
  detectedAt: Date;
}

export interface ListLatePaymentsInput {
  limit: number;
  /** Exclusive cursor: the late_payment_id of the last row of the previous page. */
  after?: string;
  reviewStatus?: LatePaymentReviewStatus;
}

export interface LatePaymentReviewRepository {
  /** Newest first (late_payment_id is a ULID, so id order is detection order). Returns up to limit + 1 rows so the caller can tell whether another page exists. */
  listLatePayments(input: ListLatePaymentsInput): Promise<LatePaymentRecord[]>;
}

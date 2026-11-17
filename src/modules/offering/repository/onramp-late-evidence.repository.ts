import type { OnrampLateEvidenceState } from "../domain/onramp-late-evidence.policy.js";
import type { OnrampLateEvidenceSnapshot } from "../domain/onramp-late-evidence-alert.policy.js";

export interface RecordOnrampLateEvidenceInput {
  /** Coinbase's transaction id: what an entry is unique on. */
  providerTransactionId: string;
  txHash: string | null;
  destinationWallet: string;
  reservationId: string;
  /** The reservation's stage when the transaction was seen; never 'initiated'. */
  reservationStage: string;
  /** The purchased amount, as a decimal string (at most 6 decimals). */
  amount: string;
  asset: string;
  state: OnrampLateEvidenceState;
  observedAt: Date;
  traceId: string;
}

export interface RecordOnrampLateEvidenceResult {
  evidenceId: string;
  /** False when the provider transaction was already on file: nothing was written. */
  newlyRecorded: boolean;
}

/**
 * The write side of the late-evidence list. Idempotent on the provider
 * transaction id, so the poll, a webhook job and a redelivered webhook that
 * all see the same transaction leave one entry.
 */
export interface OnrampLateEvidenceRecorder {
  recordLateEvidence(input: RecordOnrampLateEvidenceInput): Promise<RecordOnrampLateEvidenceResult>;
}

export type OnrampLateEvidenceReviewState = "unreviewed" | "reviewed";

export interface OnrampLateEvidenceRecord {
  evidenceId: string;
  providerTransactionId: string;
  txHash: string | null;
  destinationWallet: string;
  reservationId: string;
  reservationStage: string;
  /** The reservation's stage now, which may have moved on since. */
  currentReservationStage: string;
  amount: string;
  asset: string;
  state: OnrampLateEvidenceState;
  observedAt: Date;
  reviewedAt: Date | null;
}

export interface ListOnrampLateEvidenceInput {
  limit: number;
  /** Exclusive cursor: the evidence id of the last row of the previous page. */
  after?: string;
  reviewState?: OnrampLateEvidenceReviewState;
}

export interface MarkOnrampLateEvidenceReviewedInput {
  evidenceId: string;
  actorAccountId: string;
  traceId: string;
  reviewedAt: Date;
}

export type MarkOnrampLateEvidenceReviewedResult =
  | { status: "reviewed"; entry: OnrampLateEvidenceRecord }
  /** Already marked by an earlier call: nothing was written and the first review time stands. */
  | { status: "already_reviewed"; entry: OnrampLateEvidenceRecord }
  | { status: "not_found" };

/** The staff side: read the list, and mark an entry reviewed. There is no other action. */
export interface OnrampLateEvidenceReviewRepository {
  /** Newest first (the id is a ULID, so id order is the order entries were first seen). Returns up to limit + 1 rows so the caller can tell whether another page exists. */
  listLateEvidence(input: ListOnrampLateEvidenceInput): Promise<OnrampLateEvidenceRecord[]>;
  /** Sets reviewed_at once, with an audit row naming the staff account, in one transaction. */
  markLateEvidenceReviewed(input: MarkOnrampLateEvidenceReviewedInput): Promise<MarkOnrampLateEvidenceReviewedResult>;
}

/** What the standing alert reads. */
export interface OnrampLateEvidenceAlertSource {
  unreviewedLateEvidenceSnapshot(): Promise<OnrampLateEvidenceSnapshot>;
}

export interface PublishFinalOfferingTermsInput {
  offeringId: string;
  accountId: string;
  founderReviewNotes: string;
  traceId: string;
  publishedAt: Date;
}

export interface PublishedFinalOfferingTerms {
  offeringId: string;
  finalOfferingPublishedAt: Date;
  platformRightsEndAt: Date;
  effectiveRightsEndAt: Date;
  reservationsAwaitingReconfirmation: number;
  reservationsCancelled: number;
}

export type PublishFinalOfferingTermsConflict =
  | "offering_not_found"
  | "not_open"
  | "already_published"
  | "target_not_reached"
  | "disclosure_pack_incomplete";

export interface PublishFinalOfferingTermsResult {
  published: PublishedFinalOfferingTerms | null;
  conflict: PublishFinalOfferingTermsConflict | null;
}

export interface ReconfirmReservationInput {
  reservationId: string;
  accountId: string;
  traceId: string;
  reconfirmedAt: Date;
}

export type ReconfirmReservationConflict =
  | "not_found"
  | "not_awaiting_reconfirmation"
  | "window_closed"
  | "disclosure_pack_incomplete";

export interface ReconfirmReservationResult {
  reconfirmedAt: Date | null;
  conflict: ReconfirmReservationConflict | null;
}

export interface OfferingPendingFinalizationCommit {
  offeringId: string;
  effectiveRightsEndAt: Date;
}

export interface CommitOfferingFinalizationInput {
  offeringId: string;
  traceId: string;
  finalizedAt: Date;
}

export interface CommittedOfferingFinalization {
  offeringId: string;
  positionsCreated: number;
  reservationsLapsed: number;
}

export type CommitOfferingFinalizationConflict = "offering_not_found" | "not_publishable_state" | "window_still_open";

export interface CommitOfferingFinalizationResult {
  committed: CommittedOfferingFinalization | null;
  conflict: CommitOfferingFinalizationConflict | null;
}

/**
 * The three stages PAYMENT_FLOWS.md's "Phase-1 Final Offering Settlement
 * Flow" and AD-214's 168-hour reconfirmation window actually require,
 * corrected after this codebase initially collapsed them into one
 * immediate action:
 *
 * 1. publishFinalOfferingTerms — the founder's AD-244/AD-245 "proceed"
 *    decision. Locks final terms, opens the reconfirmation window, moves
 *    funded reservations to 'awaiting_reconfirmation' (not directly to a
 *    position). offerings.status stays 'pre_offering' throughout — per
 *    CORE_TABLES.md it only becomes 'final_offering' once step 3 commits.
 *    Also requires a complete, current disclosure pack to already exist
 *    (PAYMENT_FLOWS.md's Phase-1 Final Offering Settlement Flow step 4
 *    bundles publishing that package together with this step) — the
 *    window must never open against a pack no investor could act on.
 * 2. reconfirmReservation — each investor's own explicit action during the
 *    open window (silence lapses the reservation rather than silently
 *    finalizing it — PAYMENT_FLOWS.md's "Silence rule"). Re-checks the same
 *    disclosure-pack completeness rule, since a later republish (e.g. a
 *    materiality-triggered one) could make the current pack incomplete
 *    again after publishFinalOfferingTerms already succeeded.
 * 3. commitOfferingFinalization — the window-close batch (scheduled job,
 *    not a person): only now does a settlement.position_ledger row get
 *    created, only for reservations that were actually reconfirmed.
 *
 * Every step re-verifies its own preconditions under a row lock rather
 * than trusting an advisory read, the same AD-146 discipline
 * createReservation already applies to its capacity check.
 */
export interface FinalizeOfferingRepository {
  publishFinalOfferingTerms(input: PublishFinalOfferingTermsInput): Promise<PublishFinalOfferingTermsResult>;
  reconfirmReservation(input: ReconfirmReservationInput): Promise<ReconfirmReservationResult>;
  listOfferingsPendingFinalizationCommit(): Promise<OfferingPendingFinalizationCommit[]>;
  commitOfferingFinalization(input: CommitOfferingFinalizationInput): Promise<CommitOfferingFinalizationResult>;
}

export interface FinalizeOfferingInput {
  offeringId: string;
  accountId: string;
  founderReviewNotes: string;
  traceId: string;
  finalizedAt: Date;
}

export interface FinalizedOffering {
  offeringId: string;
  finalOfferingPublishedAt: Date;
  positionsCreated: number;
  reservationsCancelled: number;
}

export type FinalizeOfferingConflict = "offering_not_found" | "not_open" | "target_not_reached";

export interface FinalizeOfferingResult {
  finalized: FinalizedOffering | null;
  conflict: FinalizeOfferingConflict | null;
}

/**
 * AD-244/AD-245: the founder's one discretionary decision once an offering
 * reaches its target — proceed (this), extend the period, or close the
 * case. This is the only path that ever creates settlement.position_ledger
 * rows. Re-verifies funded_eur >= target_raise_eur under a row lock rather
 * than trusting an advisory read, the same AD-146 discipline
 * createReservation already applies to its own capacity check — a
 * concurrent sweep/expiry between the founder's read and this call must
 * not be able to finalize an offering that no longer qualifies.
 */
export interface FinalizeOfferingRepository {
  finalizeOffering(input: FinalizeOfferingInput): Promise<FinalizeOfferingResult>;
}

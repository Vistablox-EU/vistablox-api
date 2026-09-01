export interface OpenOfferingForApprovedCaseInput {
  caseId: string;
  propertyId: string;
  ipoValueEur: string;
  traceId: string;
  openedAt: Date;
}

export interface OpenedOffering {
  pivId: string;
  offeringId: string;
}

/**
 * The worker-side half of the origination-to-offering handoff (AD-145):
 * origination approval enqueues the job, this creates the Piv/Offering
 * shell the property needs to become visible and reservation-ready at
 * `pre_offering_open` (REAL_ESTATE_INTAKE_LIFECYCLE.md's "Property
 * pre-offering" — not the much later `final_offering_published_at`
 * publication, which is a separate, still-unbuilt final-terms-locking step).
 * Idempotent by design: a case's property can hold at most one Piv ever
 * (the schema's own `pivs.property_id` uniqueness), so replaying an
 * already-processed job is a safe no-op that returns the existing ids.
 */
export interface OfferingOriginationHandoffRepository {
  openOfferingForApprovedCase(input: OpenOfferingForApprovedCaseInput): Promise<OpenedOffering>;
}

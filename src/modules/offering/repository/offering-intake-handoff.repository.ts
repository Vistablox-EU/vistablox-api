export interface OpenOfferingForApprovedCaseInput {
  caseId: string;
  propertyId: string;
  ipoValueEur: string;
  traceId: string;
  openedAt: Date;
  /**
   * Whether to durably hand off to the job that opens this Piv's IPO escrow
   * campaign on-chain (AD-256). False while token settlement is dormant
   * (AD-234): no worker consumes that job or even creates its queue, and
   * enqueueing into a missing queue fails the whole open. When false,
   * Piv/Offering creation does not depend on a campaign job; when true it
   * also needs the case's ipo_end_at and an existing queue, and fails as a
   * whole (nothing is created) without them.
   */
  openEscrowCampaign: boolean;
}

export interface OpenedOffering {
  pivId: string;
  offeringId: string;
}

/**
 * The worker-side half of the intake-to-offering handoff (AD-145):
 * intake approval enqueues the job, this creates the Piv/Offering
 * shell the property needs to become visible and reservation-ready at
 * `pre_offering_open` (REAL_ESTATE_INTAKE_LIFECYCLE.md's "Property
 * pre-offering" — not the much later `final_offering_published_at`
 * publication, which is a separate, still-unbuilt final-terms-locking step).
 * Idempotent by design: a case's property can hold at most one Piv ever
 * (the schema's own `pivs.property_id` uniqueness), so replaying an
 * already-processed job is a safe no-op that returns the existing ids.
 */
export interface OfferingIntakeHandoffRepository {
  openOfferingForApprovedCase(input: OpenOfferingForApprovedCaseInput): Promise<OpenedOffering>;
}

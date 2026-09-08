export interface TransitionToPostIpoStructuringInput {
  caseId: string;
  traceId: string;
  transitionedAt: Date;
}

export interface TransitionedToPostIpoStructuring {
  caseId: string;
  stage: "post_ipo_structuring" | "approved_for_final_offering";
}

/**
 * The worker-side half of the offering-to-origination handoff (AD-145) —
 * the reverse direction of case_timers.pre_offering_open_handoff's own
 * origination-to-offering handoff. publishFinalOfferingTerms enqueues this
 * job the moment a case's ipo_value_eur is confirmed fully collected
 * (AD-245), and this moves the case's own stage from pre_offering_open to
 * post_ipo_structuring so the legal/appraisal formalization surface
 * (assignPartnerOrganization, and the partner-facing case list) becomes
 * reachable (AD-248). Idempotent by design, the same discipline
 * openOfferingForApprovedCase uses: a case already at post_ipo_structuring
 * or beyond is a safe no-op, not a second write or a thrown error, since a
 * retried or twice-delivered job must not fail merely because it already
 * landed.
 */
export interface PostIpoStructuringHandoffRepository {
  transitionToPostIpoStructuring(
    input: TransitionToPostIpoStructuringInput,
  ): Promise<TransitionedToPostIpoStructuring>;
}

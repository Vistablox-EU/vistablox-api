import type { MaterialityClassification, MaterialityThresholdType } from "../domain/materiality.policy.js";

export interface ClassifyMaterialityInput {
  offeringId: string;
  accountId: string;
  changeDescription: string;
  classification: MaterialityClassification;
  thresholdType: MaterialityThresholdType | null;
  traceId: string;
  classifiedAt: Date;
}

export interface ClassifiedMateriality {
  materialityRecordId: string;
  offeringId: string;
  classification: MaterialityClassification;
  thresholdType: MaterialityThresholdType | null;
  resetTriggered: boolean;
  /** Set iff resetTriggered: reconfirmation waits for a complete pack of at least this version. */
  requiredDisclosurePackVersion: number | null;
  classifiedAt: Date;
  effectiveRightsEndAt: Date | null;
  reservationsReset: number;
}

export type ClassifyMaterialityConflict = "offering_not_found" | "no_active_reconfirmation_window";

export interface ClassifyMaterialityResult {
  classified: ClassifiedMateriality | null;
  conflict: ClassifyMaterialityConflict | null;
}

/**
 * AD-038: every post-publication change gets a materiality_records row,
 * whether or not it resets anything — non_material changes are logged but
 * inert. A record may only be created while an offering is between
 * publishFinalOfferingTerms and commitOfferingFinalization (still
 * pre_offering with final terms published — the same window
 * reconfirmReservation itself operates in), since "post-publication change"
 * only means something once publication has happened, and AD-046 puts
 * post-finalization worsening through a separate amendment/consent path
 * this codebase does not build here.
 *
 * A material classification (per_se or reviewed — see
 * domain/materiality.policy.ts's materialityResetTriggered) resets every
 * reservation already reservation_stage: "reconfirmed" on that offering
 * back to "awaiting_reconfirmation" and restarts the full 168-hour window
 * from classifiedAt (PAYMENT_FLOWS.md's Material-change rule: "resets the
 * full 168-hour window and invalidates prior reconfirmations"). Reusing the
 * same isReconfirmationWindowOpen/effectiveRightsEndAt fields
 * commitOfferingFinalization already reads means a reset that lands after
 * the window would otherwise have closed, but before the hourly commit job
 * has actually run, correctly reopens it rather than racing a premature
 * commit.
 *
 * AD-038 also says a material change "always resets the disclosure pack."
 * This method does not publish one itself (the new document content is not
 * something a classification can supply); instead a reset records
 * required_disclosure_pack_version — one past the latest version published
 * so far — and reconfirmReservation refuses until a complete pack of at
 * least that version is current. Staff republish through
 * DisclosurePackRepository.publishDisclosurePack.
 */
export interface MaterialityRepository {
  classifyMateriality(input: ClassifyMaterialityInput): Promise<ClassifyMaterialityResult>;
}

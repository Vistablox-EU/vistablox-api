export const materialityClassifications = ["per_se_material", "reviewed_material", "non_material"] as const;
export type MaterialityClassification = (typeof materialityClassifications)[number];

export const materialityThresholdTypes = ["valuation", "cashflow", "gross_rent", "closing_delay"] as const;
export type MaterialityThresholdType = (typeof materialityThresholdTypes)[number];

/**
 * AD-038 / PAYMENT_FLOWS.md's "Materiality Test" and "Per Se Material
 * Changes" list define WHICH bucket a change falls into as a legal/business
 * judgment call made by the classifying staff member (AD-038's
 * consequences: "assessed by legal and offering ownership"; confirmed as
 * admin_operations's call by ARCHITECTURE_DECISIONS.md's AD-038 role
 * discussion) — this codebase does not attempt to infer that from
 * structured inputs, the same way FinalizeOfferingService's
 * founder_review_notes records a human decision rather than computing one.
 *
 * What IS mechanical, and enforced here rather than left to discretion, is
 * the CONSEQUENCE of a given classification: PAYMENT_FLOWS.md's
 * Withdrawal/Cancellation Window table states the rule plainly — "Any
 * material change resets the full 168-hour window and invalidates prior
 * reconfirmations." AD-046 confirms reviewed-material thresholds are
 * "escalation floors, not safe harbors": once staff classify a change as
 * material (per_se or reviewed), it always resets; only non_material never
 * does. reset_triggered is therefore derived from classification rather
 * than accepted as a separate caller-supplied flag that could drift from
 * it.
 */
export function materialityResetTriggered(classification: MaterialityClassification): boolean {
  return classification !== "non_material";
}

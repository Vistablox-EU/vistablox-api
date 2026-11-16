/**
 * AD-037 / VISTABLOX_BACKEND_DISCUSSION.md's "Mandatory Core Pack" table:
 * the fixed, closed list of document kinds a disclosure pack is built from.
 * `ecsp_kiis` is listed there as "Yes for live ECSP offers" rather than
 * unconditionally — but AD-043 already assumes ECSP authorisation for every
 * phase-1 live offer, so there is no non-ECSP path in this codebase to make
 * conditional against; it is treated as mandatory like the rest.
 */
export const disclosureDocumentTypes = [
  "ecsp_kiis",
  "priips_kid",
  "final_offer_summary",
  "final_terms_sheet",
  "issuer_offeror_structure_sheet",
  "investor_rights_payout_waterfall_summary",
  "risk_factors_summary",
  "property_appraisal_summary",
  "fees_costs_tax_liquidity_summary",
  "withdrawal_cancellation_supplement_rights_notice",
  "full_prospectus",
] as const;
export type DisclosureDocumentType = (typeof disclosureDocumentTypes)[number];

/**
 * The same table marks every document "Yes" (core reading) except the full
 * prospectus, which is "Mandatory availability" only — "must be downloadable
 * even if not mandatory as the core reading layer". This mapping is
 * deterministic, so it's computed here rather than trusted as a caller-
 * supplied flag the way CORE_TABLES.md's own comment on this column already
 * frames it ("false only for the full prospectus").
 */
export function isCoreReadingDocumentType(documentType: DisclosureDocumentType): boolean {
  return documentType !== "full_prospectus";
}

/**
 * AD-037: "An investor must not be able to reconfirm against an incomplete,
 * draft, or superseded pack." This reports whether a given set of document
 * types satisfies that mandatory list — informational on publish, since a
 * pack published before final terms (the "initial" pre-offering moment
 * `hasDisclosurePack` gates reservations on) is legitimately allowed to be
 * partial. publishFinalOfferingTerms and reconfirmReservation use it as a
 * hard gate.
 */
export function isCompleteDisclosurePack(documentTypes: readonly DisclosureDocumentType[]): boolean {
  const present = new Set(documentTypes);
  return disclosureDocumentTypes.every((required) => present.has(required));
}

/**
 * AD-038: a material change "always resets the disclosure pack", and the
 * classifying staff member republishes it as a separate step. A reset
 * therefore requires a pack strictly newer than every version published up
 * to the classification instant (`null` when none has been published yet).
 */
export function requiredDisclosurePackVersionAfterReset(latestPublishedVersion: number | null): number {
  return (latestPublishedVersion ?? 0) + 1;
}

/**
 * AD-037's "superseded pack" rule applied to materiality resets: an investor
 * must not reconfirm against a pack published before the latest reset.
 * `requiredVersion` is the highest required_disclosure_pack_version over the
 * offering's reset-triggering materiality records, `null` if there are none.
 */
export function satisfiesRequiredDisclosurePackVersion(input: {
  currentPackVersion: number | null;
  requiredVersion: number | null;
}): boolean {
  if (input.requiredVersion === null) {
    return true;
  }
  return input.currentPackVersion !== null && input.currentPackVersion >= input.requiredVersion;
}

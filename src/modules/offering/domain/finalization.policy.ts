import { toCents } from "./currency.js";

/**
 * AD-245: full ipo_value_eur (target_raise_eur) must be collected — extend
 * or close are the only paths when the target isn't met, so this is a hard
 * gate, not a soft target. "Collected" means funded (a successful purchase
 * landed), not merely reserved: reservedCapacityEur can equal
 * targetRaiseEur while some of those reservations never completed payment.
 */
export function isOfferingFinalizable(input: {
  status: string;
  targetRaiseEur: string;
  fundedEur: string;
}): boolean {
  return input.status === "pre_offering" && toCents(input.fundedEur) >= toCents(input.targetRaiseEur);
}

/**
 * The 1-unit-per-EUR convention decided alongside this feature: a funded
 * reservation's committed amount_eur becomes both its position's
 * unit_count and cost_basis_eur, treating the tokenized instrument as
 * EUR-denominated (AD-247: "only a contractual obligation is tokenized...
 * a note-type instrument", not equity with its own independent share
 * price). This deliberately does not touch AD-238's owner-retained
 * position — that position has no cash reservation or cost basis to apply
 * this rule to, and remains the separate, already-flagged schema gap
 * CORE_TABLES.md names under position_ledger.
 */
export function costBasisToUnitCount(costBasisEur: string): string {
  return costBasisEur;
}

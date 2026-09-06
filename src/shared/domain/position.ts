/**
 * AD-247's 1-unit-per-EUR convention: an investor position's cost basis in
 * EUR is also its unit count. Both offering finalization and on-chain escrow
 * settlement use this rule, so it belongs at their shared domain boundary.
 */
export function costBasisToUnitCount(costBasisEur: string): string {
  return costBasisEur;
}

import { toCents } from "./currency.js";

export { costBasisToUnitCount } from "../../../shared/domain/position.js";

/**
 * AD-245: full ipo_value_eur (target_raise_eur) must be collected — extend
 * or close are the only paths when the target isn't met, so this is a hard
 * gate, not a soft target. "Collected" means funded (a successful purchase
 * landed), not merely reserved: reservedCapacityEur can equal
 * targetRaiseEur while some of those reservations never completed payment.
 *
 * This gates only the founder's "publish final terms" action (PAYMENT_FLOWS.md
 * step 4) — the offering does not finalize immediately: publishing opens a
 * mandatory reconfirmation window (AD-214), and finalization itself only
 * happens once that window closes (see isReconfirmationWindowOpen /
 * commit-offering-finalization.service.ts).
 */
export function canPublishFinalOfferingTerms(input: {
  status: string;
  finalOfferingPublishedAt: Date | null;
  targetRaiseEur: string;
  fundedEur: string;
}): boolean {
  return (
    input.status === "pre_offering" &&
    input.finalOfferingPublishedAt === null &&
    toCents(input.fundedEur) >= toCents(input.targetRaiseEur)
  );
}

/**
 * AD-214 / PAYMENT_FLOWS.md's "Effective Investor-Rights Window Override":
 * effective_rights_end_at = max(all applicable investor-rights end times).
 * No broader statutory/supplement-based rights table is documented anywhere
 * yet to compute that max over, so this codebase uses the 168-hour platform
 * default as effective_rights_end_at directly — a deliberate simplification,
 * not a claim that no broader right could ever apply.
 */
export const PLATFORM_RIGHTS_WINDOW_HOURS = 168;

export function computeEffectiveRightsEndAt(publishedAt: Date): Date {
  return new Date(publishedAt.getTime() + PLATFORM_RIGHTS_WINDOW_HOURS * 60 * 60 * 1000);
}

export function isReconfirmationWindowOpen(input: { effectiveRightsEndAt: Date; now: Date }): boolean {
  return input.now.getTime() < input.effectiveRightsEndAt.getTime();
}

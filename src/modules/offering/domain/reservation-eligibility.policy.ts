export const reservationBlockers = [
  "account_restricted",
  "kyc_not_eligible",
  "kyc_renewal_due",
  "login_methods_incomplete",
  "payment_account_not_ready",
  "disclosure_pack_unavailable",
  "offering_not_open",
  "capacity_exhausted",
  "funding_rail_unavailable",
  "recovery_cooldown_active",
] as const;

export type ReservationBlocker = (typeof reservationBlockers)[number];

export type AccountReadinessStatus = "active" | "recovery_review" | "suspended_restricted";

/**
 * money.money_events.capital_state values meaning EURC has actually landed
 * for a reservation, in some form (AD-253). The exact same three values are
 * also hardcoded directly into the getInvestorDetail raw SQL's funded_eur
 * projection in prisma-offering.repository.ts — keep both in sync if this
 * ever changes; the SQL wasn't switched to interpolate this constant to
 * avoid touching a working, tested query for a stylistic dedup.
 */
export const FUNDED_CAPITAL_STATES = ["eurc_reserved", "reconfirmation_pending", "eurc_finalized"] as const;

export function isReservationFunded(latestCapitalState: string | null): boolean {
  return latestCapitalState !== null && (FUNDED_CAPITAL_STATES as readonly string[]).includes(latestCapitalState);
}

export function isKycCurrent(input: {
  kycEligibilityState: string | null;
  kycRenewalDueAt: Date | null;
  now: Date;
}): boolean {
  return (
    input.kycEligibilityState === "eligible" &&
    input.kycRenewalDueAt !== null &&
    input.kycRenewalDueAt > input.now
  );
}

export function isLoginMethodsComplete(
  loginMethods: ReadonlyArray<"passkey" | "google" | "apple">,
): boolean {
  const methods = new Set(loginMethods);
  return methods.has("passkey") && (methods.has("google") || methods.has("apple"));
}

export function isInvestmentEligible(input: {
  accountStatus: AccountReadinessStatus;
  kycCurrent: boolean;
  loginMethodsComplete: boolean;
}): boolean {
  return input.accountStatus === "active" && input.kycCurrent && input.loginMethodsComplete;
}

/**
 * The single source of truth for whether a reservation may be created on an
 * offering right now — GetInvestorOfferingService reports this list as
 * read-only guidance, and CreateReservationService re-checks it against
 * fresh, transactionally-locked data before writing (AD-146: a passing read
 * here is advisory only, never a substitute for the atomic check at write
 * time).
 */
export function computeReservationBlockers(input: {
  now: Date;
  fundingRailAvailable: boolean;
  offeringStatus: string;
  finalTermsPublished: boolean;
  hasDisclosurePack: boolean;
  remainingCapacityEur: string;
  accountStatus: AccountReadinessStatus;
  kycEligibilityState: string | null;
  kycRenewalDueAt: Date | null;
  loginMethods: ReadonlyArray<"passkey" | "google" | "apple">;
  walletProvisioned: boolean;
  /** ACCOUNT_RECOVERY_POLICY.md's 72-hour post-recovery restriction — still active when this is set and in the future. */
  recoveryCooldownEndsAt: Date | null;
}): ReservationBlocker[] {
  const kycCurrent = isKycCurrent({
    kycEligibilityState: input.kycEligibilityState,
    kycRenewalDueAt: input.kycRenewalDueAt,
    now: input.now,
  });
  const loginMethodsComplete = isLoginMethodsComplete(input.loginMethods);
  const blockers: ReservationBlocker[] = [];

  if (input.accountStatus !== "active") blockers.push("account_restricted");
  if (input.kycEligibilityState !== "eligible") {
    blockers.push("kyc_not_eligible");
  } else if (!kycCurrent) {
    blockers.push("kyc_renewal_due");
  }
  if (!loginMethodsComplete) blockers.push("login_methods_incomplete");
  if (!input.walletProvisioned) blockers.push("payment_account_not_ready");
  if (!input.hasDisclosurePack) blockers.push("disclosure_pack_unavailable");
  // offerings.status stays 'pre_offering' through the entire reconfirmation
  // window (CORE_TABLES.md: it only becomes 'final_offering' once the
  // window closes and the finalization batch commits) — so closing new
  // reservations off once final terms publish needs its own check, not
  // just the status one.
  if (input.offeringStatus !== "pre_offering" || input.finalTermsPublished) {
    blockers.push("offering_not_open");
  }
  if (input.remainingCapacityEur === "0.00") blockers.push("capacity_exhausted");
  if (!input.fundingRailAvailable) blockers.push("funding_rail_unavailable");
  if (input.recoveryCooldownEndsAt !== null && input.recoveryCooldownEndsAt > input.now) {
    blockers.push("recovery_cooldown_active");
  }

  return blockers;
}

/**
 * The capacity-hold policy decided alongside AD-255: reserve capacity
 * immediately at creation, auto-expire and release it if the reservation is
 * still unfunded 15 minutes later. Only 'initiated' reservations are ever
 * eligible — once a reservation moves past that (reconfirmed, finalized,
 * already cancelled/lapsed), this predicate no longer applies to it.
 */
export function isReservationExpired(input: {
  createdAt: Date;
  now: Date;
  expiryMinutes: number;
}): boolean {
  return input.createdAt.getTime() + input.expiryMinutes * 60_000 < input.now.getTime();
}

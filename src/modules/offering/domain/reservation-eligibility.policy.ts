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
] as const;

export type ReservationBlocker = (typeof reservationBlockers)[number];

export type AccountReadinessStatus = "active" | "recovery_review" | "suspended_restricted";

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
  loginMethods: ReadonlyArray<"google" | "email_password">,
): boolean {
  const methods = new Set(loginMethods);
  return methods.has("google") && methods.has("email_password");
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
  hasDisclosurePack: boolean;
  remainingCapacityEur: string;
  accountStatus: AccountReadinessStatus;
  kycEligibilityState: string | null;
  kycRenewalDueAt: Date | null;
  loginMethods: ReadonlyArray<"google" | "email_password">;
  walletProvisioned: boolean;
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
  if (input.offeringStatus !== "pre_offering") blockers.push("offering_not_open");
  if (input.remainingCapacityEur === "0.00") blockers.push("capacity_exhausted");
  if (!input.fundingRailAvailable) blockers.push("funding_rail_unavailable");

  return blockers;
}

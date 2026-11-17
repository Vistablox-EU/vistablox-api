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
  "settlement_escrow_not_ready",
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

/**
 * Investing needs an enrolled device (its biometric key, `device_key`) plus
 * a linked Google or Apple sign-in. A `passkey` row no longer counts:
 * customer passkeys are gone, and only staff keep one.
 */
export function isLoginMethodsComplete(
  loginMethods: ReadonlyArray<"passkey" | "google" | "apple" | "device_key">,
): boolean {
  const methods = new Set(loginMethods);
  return methods.has("device_key") && (methods.has("google") || methods.has("apple"));
}

export function isInvestmentEligible(input: {
  accountStatus: AccountReadinessStatus;
  kycCurrent: boolean;
  loginMethodsComplete: boolean;
}): boolean {
  return input.accountStatus === "active" && input.kycCurrent && input.loginMethodsComplete;
}

/**
 * True while the offering's IPO period is still running. ipo_end_at is the
 * end of collection (CORE_TABLES.md: an extension updates it in place), so
 * the instant it is reached the period is over. A missing deadline fails
 * closed: an approved case always has one, and reverting the approval clears
 * it, so an offering without one is not open for collection.
 */
export function isWithinIpoPeriod(input: { ipoEndAt: Date | null; now: Date }): boolean {
  return input.ipoEndAt !== null && input.now.getTime() < input.ipoEndAt.getTime();
}

/**
 * What the settlement module last observed of an offering's IPO escrow
 * campaign (settlement.ipo_escrow_campaigns, #176): the campaign state at the
 * last read, the on-chain deadline it reported, and the escrow contract it was
 * read from.
 */
export interface SettlementEscrowCampaignObservation {
  /** not_opened | open | successful | failed, as the settlement module last read it. */
  state: string;
  deadlineAt: Date;
  /**
   * The escrow contract the observation was read from. An observation of
   * another contract (the contract was redeployed since) says nothing about
   * the one this backend now uses.
   */
  escrowContractAddress: string;
}

/**
 * Whether reservations are gated on the offering's settlement escrow at all
 * (AD-286, decided 2026-11-17). They are only where the settlement bundle is
 * configured; where it is dormant (AD-234) there is no gate, and no campaign
 * exists to wait for. The offering repository decides this once, from the same
 * predicate the worker uses (isSettlementBundleConfigured), and hands the
 * answer to the read side and the write side alike, so the two cannot disagree.
 *
 * Where it is gated, `escrowContractAddress` is the escrow contract this
 * backend is configured to use (VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS): the
 * campaign has to have been observed on that contract.
 */
export type SettlementEscrowGate =
  | { gated: false }
  | { gated: true; escrowContractAddress: string; campaign: SettlementEscrowCampaignObservation | null };

function sameContractAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * True when reservations may proceed as far as settlement is concerned:
 * the gate is off, or the campaign was last observed Open on the configured
 * escrow contract and its deadline is still ahead. "Open" is judged at `now`,
 * not remembered: a campaign whose deadline has passed takes no contribution
 * (the contract refuses it) and is not ready even when no one has re-read it
 * yet, and one last seen Successful, Failed or no longer opened is not ready.
 * No row at all is not ready, and neither is a row recorded for another escrow
 * contract: contribute() on the configured one would revert, whatever the old
 * contract's campaign did (addresses compare case-insensitively, as an EIP-55
 * checksum is only a case pattern).
 */
export function isSettlementEscrowReady(gate: SettlementEscrowGate, now: Date): boolean {
  if (!gate.gated) return true;
  const campaign = gate.campaign;
  return (
    campaign !== null &&
    sameContractAddress(campaign.escrowContractAddress, gate.escrowContractAddress) &&
    campaign.state === "open" &&
    now.getTime() < campaign.deadlineAt.getTime()
  );
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
  /**
   * Whether the offering's IPO escrow campaign gates reservations, and if so
   * what was last observed of it (#176, AD-286): money collected for an
   * offering whose campaign is not open has nowhere to settle.
   */
  settlementEscrow: SettlementEscrowGate;
  offeringStatus: string;
  finalTermsPublished: boolean;
  /** intake.cases.ipo_end_at for the offering's case; null means no deadline was set. */
  ipoEndAt: Date | null;
  hasDisclosurePack: boolean;
  remainingCapacityEur: string;
  accountStatus: AccountReadinessStatus;
  kycEligibilityState: string | null;
  kycRenewalDueAt: Date | null;
  loginMethods: ReadonlyArray<"passkey" | "google" | "apple" | "device_key">;
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
  // just the status one. The IPO period also ends collection (AD-244,
  // PAYMENT_FLOWS.md "Property pre-offering"): no new reservation once
  // ipo_end_at has passed, and none without a deadline at all.
  if (
    input.offeringStatus !== "pre_offering" ||
    input.finalTermsPublished ||
    !isWithinIpoPeriod({ ipoEndAt: input.ipoEndAt, now: input.now })
  ) {
    blockers.push("offering_not_open");
  }
  if (input.remainingCapacityEur === "0.00") blockers.push("capacity_exhausted");
  if (!input.fundingRailAvailable) blockers.push("funding_rail_unavailable");
  if (!isSettlementEscrowReady(input.settlementEscrow, input.now)) blockers.push("settlement_escrow_not_ready");
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

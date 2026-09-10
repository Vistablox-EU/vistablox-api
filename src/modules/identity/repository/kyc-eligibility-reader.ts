// Read-only boundary port for KYC eligibility state, for modules outside
// identity (origination, offering, profile, wallet) that gate their own
// logic on an account's KYC status. Deliberately separate from
// KycRepository (kyc.repository.ts): that interface is identity's own
// internal read/write contract for the session state machine and carries
// internal-only fields (operationalSubstatus, everRequiredManualReview,
// proof-of-address session bookkeeping) that consumers outside this module
// have no business depending on. This one exposes exactly the fields those
// four modules need, backed by the single shared PrismaKycRepository
// instance each process constructs -- a live read against
// identity.kyc_eligibility, not a local copy.
//
// GetKycDisplayProfileService, inside identity itself, is a fifth consumer
// of this same port for the same reason: it needs exactly this snapshot
// shape, re-derived live rather than trusting a caller-supplied copy.
export interface KycEligibilitySnapshot {
  accountId: string;
  diditReference: string | null;
  providerStatus: string | null;
  eligibilityState: string;
  residenceCountryCode: string | null;
  taxResidenceCountryCode: string | null;
  proofOfAddressStatus: string;
  proofOfAddressCurrentUntil: Date | null;
  lastVerifiedAt: Date | null;
  renewalDueAt: Date | null;
}

export interface KycEligibilityReader {
  getEligibilitySnapshot(accountId: string): Promise<KycEligibilitySnapshot | null>;
}

export interface InvestorProfileRecord {
  accountId: string;
  accountStatus: "active" | "recovery_review" | "suspended_restricted";
  protectedContactEmail: string | null;
  createdAt: Date;
  loginMethods: Array<{
    methodType: "google" | "email_password";
    linkedAt: Date;
  }>;
  kyc: {
    diditReference: string | null;
    providerStatus: string | null;
    eligibilityState: string;
    residenceCountryCode: string | null;
    taxResidenceCountryCode: string | null;
    proofOfAddressStatus: string;
    proofOfAddressCurrentUntil: Date | null;
    lastVerifiedAt: Date | null;
    renewalDueAt: Date | null;
  } | null;
  reservationCount: number;
  activePositionCount: number;
  walletRegistration: {
    requestedAt: Date;
    registeredAt: Date | null;
  } | null;
}

export interface InvestorProfileRepository {
  get(accountId: string): Promise<InvestorProfileRecord | null>;
}

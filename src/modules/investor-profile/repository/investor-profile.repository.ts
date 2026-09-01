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
  listReservations(input: {
    accountId: string;
    limit: number;
    after?: InvestorReservationCursor;
  }): Promise<InvestorReservationRecord[]>;
  listCurrentPositions(input: {
    accountId: string;
    limit: number;
    after?: InvestorPositionCursor;
  }): Promise<InvestorPositionRecord[]>;
}

export interface InvestorReservationCursor {
  createdAt: Date;
  id: string;
}

export interface InvestorPositionCursor {
  activatedAt: Date | null;
  id: string;
}

export interface InvestorPropertySummary {
  propertyType: "residential";
  countryCode: string;
  city: string | null;
}

export interface InvestorReservationRecord {
  reservationId: string;
  offeringId: string;
  offeringStatus: "pre_offering" | "final_offering" | "closed";
  amountEur: string;
  reservationStage:
    | "initiated"
    | "awaiting_reconfirmation"
    | "reconfirmed"
    | "finalized"
    | "cancelled"
    | "lapsed";
  disclosurePackVersionAtReservation: string | null;
  reconfirmedAt: Date | null;
  reservationFinalizedAt: Date | null;
  createdAt: Date;
  latestMoneyEvent: {
    capitalState:
      | "initiated"
      | "eurc_purchase_pending"
      | "purchase_failed"
      | "eurc_reserved"
      | "reconfirmation_pending"
      | "eurc_finalized"
      | "provider_disputed";
    amountEur: string;
    amountEurc: string | null;
    recordedAt: Date;
  } | null;
  property: InvestorPropertySummary;
}

export interface InvestorPositionRecord {
  positionId: string;
  reservationId: string;
  offeringId: string;
  pivId: string;
  unitCount: string;
  costBasisEur: string;
  positionStatus: "pending_internal_settlement" | "active";
  activatedAt: Date | null;
  property: InvestorPropertySummary;
}

export interface InvestorActivityRepository {
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

// Read-only boundary port for activity summary counts, for modules outside
// investor-activity (profile, so far) that need reservation/position counts
// without depending on this module's paginated listing surface. Backed by
// the single shared PrismaInvestorActivityRepository instance each process
// constructs -- a live read, not a local copy. Same rationale as
// KycEligibilityReader in identity/repository/kyc-eligibility-reader.ts.
export interface InvestorActivitySummary {
  reservationCount: number;
  activePositionCount: number;
}

export interface InvestorActivitySummaryReader {
  getSummary(accountId: string): Promise<InvestorActivitySummary>;
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
  // Null for a position that originated directly from an AD-256 IPO escrow
  // contribution rather than the Stripe/reconfirmation reservation flow.
  reservationId: string | null;
  offeringId: string | null;
  pivId: string;
  unitCount: string;
  costBasisEur: string;
  positionStatus: "pending_internal_settlement" | "active";
  activatedAt: Date | null;
  property: InvestorPropertySummary;
}

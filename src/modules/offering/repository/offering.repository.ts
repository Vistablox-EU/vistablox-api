import type { PublicOfferingStatus } from "../domain/public-offering.policy.js";

export interface OfferingCursor {
  createdAt: Date;
  id: string;
}

export interface PublicOfferingRecord {
  id: string;
  status: PublicOfferingStatus;
  targetRaiseEur: string;
  createdAt: Date;
  property: {
    propertyType: "residential";
    countryCode: string;
    city: string | null;
  };
  ipoEndAt: Date | null;
}

export interface ListPublicOfferingsInput {
  limit: number;
  after?: OfferingCursor;
}

export type InvestorOfferingStatus = "pre_offering" | "final_offering" | "closed";

export interface InvestorOfferingDetailRecord {
  id: string;
  status: InvestorOfferingStatus;
  minimumRaiseEur: string;
  targetRaiseEur: string;
  finalOfferingPublishedAt: Date | null;
  platformRightsEndAt: Date | null;
  effectiveRightsEndAt: Date | null;
  ipoEndAt: Date | null;
  issuer: {
    pivId: string;
    legalName: string | null;
    jurisdiction: string | null;
    registrationNumber: string | null;
    structurePattern: string;
    incorporatedAt: Date | null;
  };
  property: {
    propertyId: string;
    propertyType: "residential";
    countryCode: string;
    city: string | null;
    addressLine: string | null;
    ownerDeclaredValueEur: string;
    appraisalValueOpinionEur: string | null;
  };
  currentDisclosurePack: {
    id: string;
    version: number;
    publishedAt: Date;
    documents: Array<{
      id: string;
      documentType: string;
      documentRef: string;
      isCoreReading: boolean;
    }>;
  } | null;
  materialityRecords: Array<{
    id: string;
    changeDescription: string;
    classification: string;
    resetTriggered: boolean;
    classifiedAt: Date;
  }>;
  reservedCapacityEur: string;
  fundedEur: string;
  accountReadiness: {
    status: "active" | "recovery_review" | "suspended_restricted";
    loginMethods: Array<"passkey" | "google" | "apple" | "device_key">;
    kycEligibilityState: string | null;
    kycRenewalDueAt: Date | null;
    /**
     * True only for a CONFIRMED wallet registration. A pending claim is
     * replaceable by its own account and proves nothing about who controls
     * the address, so it never counts as a ready payment account.
     */
    walletProvisioned: boolean;
    /** The confirmed address (the Coinbase onramp destination), or null while the registration is missing or still pending. */
    walletAddress: string | null;
    payoutWalletRegistered: boolean;
    /** Still-active post-recovery restriction (ACCOUNT_RECOVERY_POLICY.md), if any — null once it has lapsed. */
    recoveryCooldownEndsAt: Date | null;
  };
}

export interface OfferingRepository {
  listPublic(input: ListPublicOfferingsInput): Promise<PublicOfferingRecord[]>;
  getInvestorDetail(input: {
    offeringId: string;
    accountId: string;
  }): Promise<InvestorOfferingDetailRecord | null>;
}

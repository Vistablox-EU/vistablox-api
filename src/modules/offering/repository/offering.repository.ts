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

export interface OfferingRepository {
  listPublic(input: ListPublicOfferingsInput): Promise<PublicOfferingRecord[]>;
}

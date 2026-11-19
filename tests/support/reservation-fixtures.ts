import type { InvestorOfferingDetailRecord } from "../../src/modules/offering/repository/offering.repository.js";

export const fixtureNow = new Date("2026-09-02T10:00:00.000Z");
export const fixtureWalletAddress = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";

/** An offering an account can reserve in: open, funding rail permitting, with room and a complete investor profile. */
export function eligibleOfferingDetail(
  overrides: Partial<InvestorOfferingDetailRecord> = {},
): InvestorOfferingDetailRecord {
  return {
    id: "offering_01",
    status: "pre_offering",
    minimumRaiseEur: "100000.00",
    targetRaiseEur: "200000.00",
    finalOfferingPublishedAt: null,
    platformRightsEndAt: null,
    effectiveRightsEndAt: null,
    ipoEndAt: new Date("2099-12-31T00:00:00.000Z"),
    settlementEscrow: { gated: false },
    issuer: {
      pivId: "piv_01",
      legalName: null,
      jurisdiction: null,
      registrationNumber: null,
      structurePattern: "default_aligned",
      incorporatedAt: null,
    },
    property: {
      propertyId: "property_01",
      propertyType: "residential",
      countryCode: "RS",
      city: "Belgrade",
      media: null,
      addressLine: null,
      ownerDeclaredValueEur: "250000.00",
      appraisalValueOpinionEur: null,
    },
    currentDisclosurePack: {
      id: "pack_01",
      version: 1,
      publishedAt: new Date("2026-08-30T12:00:00.000Z"),
      documents: [
        { id: "document_01", documentType: "ecsp_kiis", documentRef: "documents/kiis-v1.pdf", isCoreReading: true },
      ],
    },
    materialityRecords: [],
    reservedCapacityEur: "0.00",
    fundedEur: "0.00",
    accountReadiness: {
      status: "active",
      loginMethods: ["device_key", "google"],
      kycEligibilityState: "eligible",
      kycRenewalDueAt: new Date("2027-01-01T12:00:00.000Z"),
      walletProvisioned: true,
      walletAddress: fixtureWalletAddress,
      payoutWalletRegistered: false,
      recoveryCooldownEndsAt: null,
    },
    ...overrides,
  };
}

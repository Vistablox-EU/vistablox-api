import { describe, expect, it, vi } from "vitest";

import { GetInvestorOfferingService } from "../src/modules/offering/application/get-investor-offering.service.js";
import type {
  InvestorOfferingDetailRecord,
  OfferingRepository,
} from "../src/modules/offering/repository/offering.repository.js";

const currentTime = new Date("2026-09-01T12:00:00.000Z");

function detail(
  overrides: Partial<InvestorOfferingDetailRecord> = {},
): InvestorOfferingDetailRecord {
  return {
    id: "offering_01",
    status: "pre_offering",
    minimumRaiseEur: "250000.00",
    targetRaiseEur: "500000.00",
    finalOfferingPublishedAt: null,
    platformRightsEndAt: null,
    effectiveRightsEndAt: null,
    ipoEndAt: new Date("2026-10-01T12:00:00.000Z"),
    issuer: {
      pivId: "piv_01",
      legalName: "VistaBlox Berlin 01 B.V.",
      jurisdiction: "NL",
      registrationNumber: "12345678",
      structurePattern: "default_aligned",
      incorporatedAt: new Date("2026-08-01T12:00:00.000Z"),
    },
    property: {
      propertyId: "property_01",
      propertyType: "residential",
      countryCode: "DE",
      city: "Berlin",
      addressLine: "Example Strasse 1",
      ownerDeclaredValueEur: "600000.00",
      appraisalValueOpinionEur: "625000.00",
    },
    currentDisclosurePack: {
      id: "pack_01",
      version: 2,
      publishedAt: new Date("2026-08-30T12:00:00.000Z"),
      documents: [
        {
          id: "document_01",
          documentType: "ecsp_kiis",
          documentRef: "documents/offering_01/kiis-v2.pdf",
          isCoreReading: true,
        },
      ],
    },
    materialityRecords: [],
    reservedCapacityEur: "125000.00",
    fundedEur: "100000.00",
    accountReadiness: {
      status: "active",
      loginMethods: ["google", "email_password"],
      kycEligibilityState: "eligible",
      kycRenewalDueAt: new Date("2027-01-01T12:00:00.000Z"),
      walletProvisioned: true,
      payoutWalletRegistered: true,
    },
    ...overrides,
  };
}

function repository(record: InvestorOfferingDetailRecord | null): OfferingRepository {
  return {
    listPublic: vi.fn().mockResolvedValue([]),
    getInvestorDetail: vi.fn().mockResolvedValue(record),
  };
}

describe("authenticated investor offering detail", () => {
  it("returns full disclosure detail and keeps reservation closed while the rail is unavailable", async () => {
    const service = new GetInvestorOfferingService(
      repository(detail()),
      () => currentTime,
    );

    const result = await service.execute({
      offeringId: "offering_01",
      accountId: "account_01",
    });

    expect(result.data).toMatchObject({
      id: "offering_01",
      progress: {
        reserved_capacity_eur: "125000.00",
        funded_eur: "100000.00",
        remaining_capacity_eur: "375000.00",
      },
      current_disclosure_pack: {
        version: 2,
        documents: [{ document_type: "ecsp_kiis", is_core_reading: true }],
      },
      readiness: {
        investment_eligible: true,
        payment_account_ready: true,
        payout_account_verified: true,
      },
      reservation: {
        available: false,
        blockers: ["funding_rail_unavailable"],
      },
    });
  });

  it("reports every account and offering blocker without hiding disclosure access", async () => {
    const record = detail({
      status: "closed",
      reservedCapacityEur: "510000.00",
      accountReadiness: {
        status: "recovery_review",
        loginMethods: ["email_password"],
        kycEligibilityState: "eligible",
        kycRenewalDueAt: currentTime,
        walletProvisioned: false,
        payoutWalletRegistered: false,
      },
    });
    const service = new GetInvestorOfferingService(repository(record), () => currentTime);

    const result = await service.execute({
      offeringId: "offering_01",
      accountId: "account_01",
    });

    expect(result.data.current_disclosure_pack).not.toBeNull();
    expect(result.data.progress.remaining_capacity_eur).toBe("0.00");
    expect(result.data.readiness.investment_eligible).toBe(false);
    expect(result.data.reservation).toEqual({
      available: false,
      blockers: [
        "account_restricted",
        "kyc_renewal_due",
        "login_methods_incomplete",
        "payment_account_not_ready",
        "offering_not_open",
        "capacity_exhausted",
        "funding_rail_unavailable",
      ],
    });
  });

  it("can open the provider-neutral reservation capability after a supported rail is configured", async () => {
    const service = new GetInvestorOfferingService(
      repository(detail()),
      () => currentTime,
      true,
    );

    const result = await service.execute({
      offeringId: "offering_01",
      accountId: "account_01",
    });

    expect(result.data.reservation).toEqual({ available: true, blockers: [] });
  });

  it("returns the stable offering not-found error", async () => {
    const service = new GetInvestorOfferingService(repository(null), () => currentTime);

    await expect(
      service.execute({ offeringId: "missing", accountId: "account_01" }),
    ).rejects.toMatchObject({ code: "offering.not_found", status: 404 });
  });
});

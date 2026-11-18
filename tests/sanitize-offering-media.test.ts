import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import { sanitizeOfferingMedia } from "../src/modules/offering/application/sanitize-offering-media.js";
import { ListPublicOfferingsService } from "../src/modules/offering/application/list-public-offerings.service.js";
import { GetInvestorOfferingService } from "../src/modules/offering/application/get-investor-offering.service.js";
import { UpdateOfferingPresentationService } from "../src/modules/offering/application/update-offering-presentation.service.js";
import {
  listOfferingsResponseSchema,
  investorOfferingDetailResponseSchema,
} from "../src/modules/offering/api/offering.schemas.js";
import { updateOfferingPresentationResponseSchema } from "../src/modules/offering/api/offering-operations.schemas.js";
import type {
  InvestorOfferingDetailRecord,
  OfferingRepository,
  PublicOfferingRecord,
} from "../src/modules/offering/repository/offering.repository.js";

const good = "https://cdn.example.com/good.jpg";

function fakeLogger() {
  const warn = vi.fn();
  return { logger: { warn } as unknown as Logger, warn };
}

function publicRecord(id: string, media: PublicOfferingRecord["property"]["media"]): PublicOfferingRecord {
  return {
    id,
    status: "pre_offering",
    featured: false,
    targetRaiseEur: "250000.00",
    createdAt: new Date("2026-08-31T12:00:00.000Z"),
    ipoEndAt: null,
    property: { propertyType: "residential", countryCode: "RS", city: null, media },
  };
}

describe("sanitizeOfferingMedia", () => {
  it("passes valid media through without logging", () => {
    const { logger, warn } = fakeLogger();
    const media = { heroUrl: good, galleryUrls: [good] };
    expect(sanitizeOfferingMedia("off_1", media, logger)).toEqual(media);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["http://x/y.jpg", "", "not a url", `https://cdn.example.com/${"a".repeat(2100)}`])(
    "nulls an invalid hero (%#) and logs the offering id",
    (bad) => {
      const { logger, warn } = fakeLogger();
      expect(sanitizeOfferingMedia("off_1", { heroUrl: bad, galleryUrls: [good] }, logger)).toEqual({
        heroUrl: null,
        galleryUrls: [good],
      });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ offering_id: "off_1" }), expect.any(String));
    },
  );

  it("drops only the invalid gallery entries", () => {
    const { logger, warn } = fakeLogger();
    expect(sanitizeOfferingMedia("off_1", { heroUrl: null, galleryUrls: [good, "http://x/y.jpg", ""] }, logger)).toEqual({
      heroUrl: null,
      galleryUrls: [good],
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("collapses to null when nothing valid is left", () => {
    expect(sanitizeOfferingMedia("off_1", { heroUrl: "", galleryUrls: ["x"] })).toBeNull();
  });
});

describe("read paths with a malformed stored media URL", () => {
  it("keeps the public list intact: the valid row is untouched, the bad media is nulled", async () => {
    const { logger, warn } = fakeLogger();
    const repository = {
      listPublic: vi.fn().mockResolvedValue([
        publicRecord("off_good", { heroUrl: good, galleryUrls: [] }),
        publicRecord("off_bad", { heroUrl: "http://x/y.jpg", galleryUrls: [] }),
      ]),
    } as unknown as OfferingRepository;

    const result = await new ListPublicOfferingsService(repository, logger).execute({ limit: 20 });

    expect(() => listOfferingsResponseSchema.parse(result)).not.toThrow();
    expect(result.data.map((row) => row.property.media)).toEqual([
      { hero_url: good, gallery_urls: [] },
      null,
    ]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ offering_id: "off_bad" }), expect.any(String));
  });

  it("keeps the investor detail valid", async () => {
    const { logger, warn } = fakeLogger();
    const record = {
      id: "offering_01",
      status: "pre_offering",
      minimumRaiseEur: "100000.00",
      targetRaiseEur: "200000.00",
      finalOfferingPublishedAt: null,
      platformRightsEndAt: null,
      effectiveRightsEndAt: null,
      ipoEndAt: null,
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
        city: null,
        media: { heroUrl: "", galleryUrls: [good, "ftp://x"] },
        addressLine: null,
        ownerDeclaredValueEur: "250000.00",
        appraisalValueOpinionEur: null,
      },
      currentDisclosurePack: null,
      materialityRecords: [],
      reservedCapacityEur: "0.00",
      fundedEur: "0.00",
      accountReadiness: {
        status: "active",
        loginMethods: [],
        kycEligibilityState: null,
        kycRenewalDueAt: null,
        walletProvisioned: false,
        payoutWalletRegistered: false,
        recoveryCooldownEndsAt: null,
      },
    } as unknown as InvestorOfferingDetailRecord;
    const repository = { getInvestorDetail: vi.fn().mockResolvedValue(record) } as unknown as OfferingRepository;

    const result = await new GetInvestorOfferingService(repository, undefined, false, logger).execute({
      offeringId: "offering_01",
      accountId: "account_01",
    });

    expect(() => investorOfferingDetailResponseSchema.parse(result)).not.toThrow();
    expect(result.data.property.media).toEqual({ hero_url: null, gallery_urls: [good] });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ offering_id: "offering_01" }), expect.any(String));
  });

  it("answers a featured-only presentation change even when the stored media is bad", async () => {
    const { logger } = fakeLogger();
    const repository = {
      updatePresentation: vi.fn().mockResolvedValue({
        featured: true,
        media: { heroUrl: "http://x/y.jpg", galleryUrls: [good] },
      }),
    };

    const result = await new UpdateOfferingPresentationService(repository, undefined, logger).execute({
      accountId: "account_01",
      offeringId: "offering_01",
      traceId: "req_1",
      body: { featured: true },
    });

    expect(() => updateOfferingPresentationResponseSchema.parse(result)).not.toThrow();
    expect(result.data.media).toEqual({ hero_url: null, gallery_urls: [good] });
  });
});

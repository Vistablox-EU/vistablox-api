import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createInvestorOfferingRouter } from "../src/modules/offering/api/offering.router.js";
import { GetInvestorOfferingService } from "../src/modules/offering/application/get-investor-offering.service.js";
import type { OfferingRepository } from "../src/modules/offering/repository/offering.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const repository: OfferingRepository = {
  listPublic: vi.fn().mockResolvedValue([]),
  getInvestorDetail: vi.fn().mockResolvedValue({
    id: "offering_01",
    status: "pre_offering",
    minimumRaiseEur: "100000.00",
    targetRaiseEur: "200000.00",
    finalOfferingPublishedAt: null,
    platformRightsEndAt: null,
    effectiveRightsEndAt: null,
    ipoEndAt: null,
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
    },
  }),
};

function appFor(population: "customer" | "staff_partner") {
  const app = express();
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = {
      accountId: "account_01",
      providerSessionId: "session_01",
      population,
    };
    next();
  };
  app.use(requestContext);
  app.use(
    "/v1/offerings",
    createInvestorOfferingRouter(
      authenticated,
      new GetInvestorOfferingService(repository),
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("authenticated investor offering API", () => {
  it("returns customer-only detail with no intermediary caching", async () => {
    const response = await request(appFor("customer")).get(
      "/v1/offerings/offering_01",
    );

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      data: {
        id: "offering_01",
        property: { country_code: "RS", city: "Belgrade" },
        current_disclosure_pack: null,
        reservation: {
          available: false,
          blockers: [
            "kyc_not_eligible",
            "login_methods_incomplete",
            "payment_account_not_ready",
            "disclosure_pack_unavailable",
            "funding_rail_unavailable",
          ],
        },
      },
    });
    expect(repository.getInvestorDetail).toHaveBeenCalledWith({
      offeringId: "offering_01",
      accountId: "account_01",
    });
  });

  it("does not expose full disclosure detail to staff identities", async () => {
    const response = await request(appFor("staff_partner")).get(
      "/v1/offerings/offering_01",
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: "authorization.forbidden",
      status: 403,
    });
  });
});

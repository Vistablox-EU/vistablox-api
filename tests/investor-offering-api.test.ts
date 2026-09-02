import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createInvestorOfferingRouter } from "../src/modules/offering/api/offering.router.js";
import type { CoinbaseCdpClient } from "../src/modules/offering/application/coinbase-cdp-client.js";
import { CreateReservationService } from "../src/modules/offering/application/create-reservation.service.js";
import { GetInvestorOfferingService } from "../src/modules/offering/application/get-investor-offering.service.js";
import type { InvestorOfferingDetailRecord, OfferingRepository } from "../src/modules/offering/repository/offering.repository.js";
import type { CreateReservationResult, ReservationRepository } from "../src/modules/offering/repository/reservation.repository.js";
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

const reservationEligibleDetail: InvestorOfferingDetailRecord = {
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
    loginMethods: ["google", "email_password"],
    kycEligibilityState: "eligible",
    kycRenewalDueAt: new Date("2027-01-01T12:00:00.000Z"),
    walletProvisioned: true,
    walletAddress: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    payoutWalletRegistered: false,
  },
};

function buildReservationApp(options?: { detail?: InvestorOfferingDetailRecord | null }) {
  const offerings: OfferingRepository = {
    listPublic: vi.fn().mockResolvedValue([]),
    getInvestorDetail: vi
      .fn()
      .mockResolvedValue(options?.detail === undefined ? reservationEligibleDetail : options.detail),
  };
  const reservations: ReservationRepository = {
    createReservation: vi.fn(async (input): Promise<CreateReservationResult> => ({
      reservation: { reservationId: input.reservationId, createdAt: input.createdAt },
      conflict: null,
    })),
    recordMoneyEvent: vi.fn().mockResolvedValue(undefined),
  };
  const coinbase: CoinbaseCdpClient = {
    createOnrampSessionToken: vi.fn().mockResolvedValue({ token: "session-token-01", channelId: "channel-01" }),
    buildOnrampUrl: vi.fn(() => "https://pay.coinbase.com/buy/select-asset?sessionToken=session-token-01"),
    listBuyTransactions: vi.fn().mockResolvedValue({ transactions: [], nextPageKey: null }),
  };

  const app = express();
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = {
      accountId: "account_01",
      providerSessionId: "session_01",
      population: "customer",
    };
    next();
  };
  app.use(requestContext);
  app.use(express.json());
  app.use(
    "/v1/offerings",
    createInvestorOfferingRouter(
      authenticated,
      new GetInvestorOfferingService(offerings),
      undefined,
      new CreateReservationService(offerings, reservations, coinbase, {
        clock: () => new Date("2026-09-02T10:00:00.000Z"),
        generateReservationId: () => "reservation_01",
        fundingRailAvailable: true,
      }),
    ),
  );
  app.use(errorHandler);
  return { app, offerings, reservations, coinbase };
}

describe("POST /v1/offerings/:offering_id/reservations", () => {
  it("creates a reservation and returns an onramp URL", async () => {
    const { app, reservations } = buildReservationApp();

    const response = await request(app)
      .post("/v1/offerings/offering_01/reservations")
      .send({ amount_eur: "1000.00" });

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      data: {
        reservation_id: "reservation_01",
        offering_id: "offering_01",
        amount_eur: "1000.00",
        status: "initiated",
        expires_at: "2026-09-02T10:15:00.000Z",
        onramp: {
          url: "https://pay.coinbase.com/buy/select-asset?sessionToken=session-token-01",
          channel_id: "channel-01",
        },
      },
    });
    expect(reservations.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ offeringId: "offering_01", accountId: "account_01", amountEur: "1000.00" }),
    );
  });

  it("rejects a malformed amount before touching the repository", async () => {
    const { app, reservations } = buildReservationApp();

    const response = await request(app)
      .post("/v1/offerings/offering_01/reservations")
      .send({ amount_eur: "not-a-number" });

    expect(response.status).toBe(422);
    expect(reservations.createReservation).not.toHaveBeenCalled();
  });

  it("reports blockers as a 409 with structured field errors", async () => {
    const { app } = buildReservationApp({
      detail: { ...reservationEligibleDetail, accountReadiness: { ...reservationEligibleDetail.accountReadiness, status: "suspended_restricted" } },
    });

    const response = await request(app)
      .post("/v1/offerings/offering_01/reservations")
      .send({ amount_eur: "1000.00" });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "offering.reservation_not_available",
      field_errors: [{ field: "reservation", code: "account_restricted" }],
    });
  });

  it("404s for an offering that does not exist", async () => {
    const { app } = buildReservationApp({ detail: null });

    const response = await request(app)
      .post("/v1/offerings/offering_01/reservations")
      .send({ amount_eur: "1000.00" });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("offering.not_found");
  });
});

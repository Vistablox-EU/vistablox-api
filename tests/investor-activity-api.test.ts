import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createInvestorActivityRouter } from "../src/modules/investor-activity/api/investor-activity.router.js";
import {
  ListInvestorCurrentPositionsService,
  ListInvestorReservationsService,
} from "../src/modules/investor-activity/application/list-investor-activity.service.js";
import type { InvestorActivityRepository } from "../src/modules/investor-activity/repository/investor-activity.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const repository: InvestorActivityRepository = {
  listReservations: vi.fn().mockResolvedValue([]),
  listCurrentPositions: vi.fn().mockResolvedValue([]),
};

function appFor(population: "customer" | "staff_partner") {
  const app = express();
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = {
      accountId: "acct_01",
      providerSessionId: "session_01",
      population,
    };
    next();
  };
  app.use(requestContext);
  app.use(
    "/v1/investor-profile",
    createInvestorActivityRouter(
      authenticated,
      new ListInvestorReservationsService(repository),
      new ListInvestorCurrentPositionsService(repository),
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("investor activity API", () => {
  it.each(["reservations", "positions"])(
    "serves customer-only paginated %s with no-store caching",
    async (resource) => {
      const response = await request(appFor("customer")).get(
        `/v1/investor-profile/${resource}?limit=10`,
      );

      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toEqual({ data: [], page: { next_cursor: null } });
    },
  );

  it("serves an escrow-minted position that has no reservation or offering", async () => {
    // A position minted straight from an on-chain escrow contribution (AD-256)
    // is not created from a reservation, and offering_id is resolved only
    // through the reservation, so both ids are null. The response schema used
    // to require both and turned this row into a 422 for the whole page.
    vi.mocked(repository.listCurrentPositions).mockResolvedValueOnce([
      {
        positionId: "position_01",
        reservationId: null,
        offeringId: null,
        pivId: "piv_01",
        unitCount: "1000.000000",
        costBasisEur: "1000.00",
        positionStatus: "active",
        activatedAt: new Date("2026-09-20T10:00:00.000Z"),
        property: { propertyType: "residential", countryCode: "PT", city: "Porto" },
      },
    ]);

    const response = await request(appFor("customer")).get(
      "/v1/investor-profile/positions",
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      {
        position_id: "position_01",
        reservation_id: null,
        offering_id: null,
        piv_id: "piv_01",
        unit_count: "1000.000000",
        cost_basis_eur: "1000.00",
        position_status: "active",
        activated_at: "2026-09-20T10:00:00.000Z",
        property: { property_type: "residential", country_code: "PT", city: "Porto" },
      },
    ]);
  });

  it.each(["reservations", "positions"])(
    "does not expose %s to staff identities",
    async (resource) => {
      const response = await request(appFor("staff_partner")).get(
        `/v1/investor-profile/${resource}`,
      );

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: "authorization.forbidden",
        status: 403,
      });
    },
  );
});

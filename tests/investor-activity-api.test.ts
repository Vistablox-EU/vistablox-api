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

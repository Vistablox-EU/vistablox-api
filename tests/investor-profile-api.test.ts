import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createInvestorProfileRouter } from "../src/modules/investor-profile/api/investor-profile.router.js";
import { GetInvestorProfileService } from "../src/modules/investor-profile/application/get-investor-profile.service.js";
import type { ProtectedDisplayProfileProvider } from "../src/modules/investor-profile/application/protected-display-profile.js";
import type { InvestorProfileRepository } from "../src/modules/investor-profile/repository/investor-profile.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const repository: InvestorProfileRepository = {
  get: vi.fn().mockResolvedValue({
    accountId: "acct_01",
    accountStatus: "active",
    protectedContactEmail: "investor@example.com",
    createdAt: new Date("2026-01-15T10:00:00.000Z"),
    loginMethods: [],
    kyc: null,
    reservationCount: 0,
    activePositionCount: 0,
    walletRegistration: null,
  }),
};
const displayProfiles: ProtectedDisplayProfileProvider = {
  get: vi.fn().mockResolvedValue(null),
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
    createInvestorProfileRouter(
      authenticated,
      new GetInvestorProfileService(repository, displayProfiles),
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("investor profile API", () => {
  it("returns the authenticated customer's profile without intermediary caching", async () => {
    const response = await request(appFor("customer")).get("/v1/investor-profile");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      data: {
        account_id: "acct_01",
        contact_email: "investor@example.com",
        display_profile: null,
        kyc: { eligibility_state: "not_started" },
        investment_summary: { reservation_count: 0, active_position_count: 0 },
        readiness: {
          investment_eligible: false,
          payment_account_ready: false,
          payout_account_verified: false,
        },
        wallet: { status: "not_registered" },
      },
    });
  });

  it("does not expose the customer profile surface to staff identities", async () => {
    const response = await request(appFor("staff_partner")).get(
      "/v1/investor-profile",
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: "authorization.forbidden",
      status: 403,
    });
  });
});

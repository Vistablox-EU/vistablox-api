import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createProfileRouter } from "../src/modules/profile/api/profile.router.js";
import { GetProfileService } from "../src/modules/profile/application/get-profile.service.js";
import type { ProtectedDisplayProfileProvider } from "../src/modules/profile/application/protected-display-profile.js";
import { UpdateAccountPreferencesService } from "../src/modules/profile/application/update-account-preferences.service.js";
import {
  defaultAccountPreferences,
  type AccountPreferencesRepository,
} from "../src/modules/profile/repository/account-preferences.repository.js";
import type { ProfileRepository } from "../src/modules/profile/repository/profile.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const repository: ProfileRepository = {
  get: vi.fn().mockResolvedValue({
    accountId: "acct_01",
    accountStatus: "active",
    protectedContactEmail: "investor@example.com",
    createdAt: new Date("2026-01-15T10:00:00.000Z"),
    loginMethods: [],
    kyc: null,
    walletStatus: null,
    activitySummary: { reservationCount: 0, activePositionCount: 0 },
    preferences: defaultAccountPreferences,
    pendingClosureRequest: null,
  }),
};
const displayProfiles: ProtectedDisplayProfileProvider = {
  get: vi.fn().mockResolvedValue(null),
};

function appFor(
  population: "customer" | "staff_partner",
  preferencesRepository: AccountPreferencesRepository,
) {
  const app = express();
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = {
      accountId: "acct_01",
      providerSessionId: "session_01",
      population,
    };
    next();
  };
  app.use(express.json());
  app.use(requestContext);
  app.use(
    "/v1/investor-profile",
    createProfileRouter(
      authenticated,
      new GetProfileService(repository, displayProfiles),
      new UpdateAccountPreferencesService(preferencesRepository),
    ),
  );
  app.use(errorHandler);
  return app;
}

const noopPreferencesRepository: AccountPreferencesRepository = {
  update: vi.fn().mockResolvedValue(defaultAccountPreferences),
};

describe("investor profile API", () => {
  it("returns the authenticated customer's profile without intermediary caching", async () => {
    const response = await request(appFor("customer", noopPreferencesRepository)).get(
      "/v1/investor-profile",
    );

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
        preferences: {
          deal_alerts_email: true,
          statements_email: true,
          marketing_email: false,
          locale: "en-US",
          timezone: "UTC",
        },
        pending_closure_request: null,
      },
    });
  });

  it("does not expose the customer profile surface to staff identities", async () => {
    const response = await request(appFor("staff_partner", noopPreferencesRepository)).get(
      "/v1/investor-profile",
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: "authorization.forbidden",
      status: 403,
    });
  });

  it("updates only the provided preference fields", async () => {
    const update = vi.fn().mockResolvedValue({
      ...defaultAccountPreferences,
      marketingEmail: true,
      timezone: "Europe/Berlin",
    });
    const preferencesRepository: AccountPreferencesRepository = { update };

    const response = await request(appFor("customer", preferencesRepository))
      .patch("/v1/investor-profile/preferences")
      .send({ marketing_email: true, timezone: "Europe/Berlin" });

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith("acct_01", {
      marketingEmail: true,
      timezone: "Europe/Berlin",
    });
    expect(response.body).toEqual({
      data: {
        deal_alerts_email: true,
        statements_email: true,
        marketing_email: true,
        locale: "en-US",
        timezone: "Europe/Berlin",
      },
    });
  });

  it("rejects an unknown IANA time zone", async () => {
    const response = await request(appFor("customer", noopPreferencesRepository))
      .patch("/v1/investor-profile/preferences")
      .send({ timezone: "Mars/Olympus_Mons" });

    expect(response.status).toBe(422);
    expect(noopPreferencesRepository.update).not.toHaveBeenCalled();
  });

  it("rejects an empty preferences update", async () => {
    const response = await request(appFor("customer", noopPreferencesRepository))
      .patch("/v1/investor-profile/preferences")
      .send({});

    expect(response.status).toBe(422);
  });
});

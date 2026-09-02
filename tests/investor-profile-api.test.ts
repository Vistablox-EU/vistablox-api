import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createInvestorProfileRouter } from "../src/modules/investor-profile/api/investor-profile.router.js";
import { GetInvestorProfileService } from "../src/modules/investor-profile/application/get-investor-profile.service.js";
import {
  ListInvestorCurrentPositionsService,
  ListInvestorReservationsService,
} from "../src/modules/investor-profile/application/list-investor-activity.service.js";
import type { ProtectedDisplayProfileProvider } from "../src/modules/investor-profile/application/protected-display-profile.js";
import { RegisterWalletService } from "../src/modules/investor-profile/application/register-wallet.service.js";
import type { InvestorProfileRepository } from "../src/modules/investor-profile/repository/investor-profile.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const eligibleKyc = {
  diditReference: null,
  providerStatus: null,
  eligibilityState: "eligible" as const,
  residenceCountryCode: "DE",
  taxResidenceCountryCode: "DE",
  proofOfAddressStatus: "current" as const,
  proofOfAddressCurrentUntil: new Date("2099-01-01T00:00:00.000Z"),
  lastVerifiedAt: new Date("2026-08-01T12:00:00.000Z"),
  renewalDueAt: new Date("2099-01-01T00:00:00.000Z"),
};

function buildApp(options?: { kyc?: typeof eligibleKyc | null; registerWallet?: InvestorProfileRepository["registerWallet"] }) {
  const repository: InvestorProfileRepository = {
    get: vi.fn().mockResolvedValue({
      accountId: "acct_01",
      accountStatus: "active",
      protectedContactEmail: "investor@example.com",
      createdAt: new Date("2026-01-15T10:00:00.000Z"),
      loginMethods: [],
      kyc: options !== undefined && "kyc" in options ? options.kyc : eligibleKyc,
      reservationCount: 0,
      activePositionCount: 0,
      walletRegistration: null,
    }),
    registerWallet:
      options?.registerWallet ??
      vi.fn().mockResolvedValue({
        walletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        registrationCommitment: "commitment_01",
        requestedAt: new Date("2026-09-02T10:00:00.000Z"),
        registeredAt: null,
      }),
    listReservations: vi.fn().mockResolvedValue([]),
    listCurrentPositions: vi.fn().mockResolvedValue([]),
  };
  const displayProfiles: ProtectedDisplayProfileProvider = {
    get: vi.fn().mockResolvedValue(null),
  };

  const app = express();
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = {
      accountId: "acct_01",
      providerSessionId: "session_01",
      population: "customer",
    };
    next();
  };
  app.use(requestContext);
  app.use(express.json());
  app.use(
    "/v1/investor-profile",
    createInvestorProfileRouter(
      authenticated,
      new GetInvestorProfileService(repository, displayProfiles),
      new ListInvestorReservationsService(repository),
      new ListInvestorCurrentPositionsService(repository),
      new RegisterWalletService(repository, () => new Date("2026-09-02T10:00:00.000Z")),
    ),
  );
  app.use(errorHandler);
  return { app, repository };
}

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
  registerWallet: vi.fn(),
  listReservations: vi.fn().mockResolvedValue([]),
  listCurrentPositions: vi.fn().mockResolvedValue([]),
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
      new ListInvestorReservationsService(repository),
      new ListInvestorCurrentPositionsService(repository),
      new RegisterWalletService(repository),
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
});

describe("POST /v1/investor-profile/wallet", () => {
  const validAddress = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

  it("registers a wallet address for a KYC-eligible investor", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet")
      .send({ wallet_address: validAddress });

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      data: {
        wallet_address: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        registration_commitment: "commitment_01",
        status: "pending",
        requested_at: "2026-09-02T10:00:00.000Z",
        registered_at: null,
      },
    });
    expect(repository.registerWallet).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_01", walletAddress: validAddress }),
    );
  });

  it("rejects a malformed wallet address before touching the repository", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet")
      .send({ wallet_address: "not-an-address" });

    expect(response.status).toBe(422);
    expect(repository.registerWallet).not.toHaveBeenCalled();
  });

  it("requires current KYC eligibility", async () => {
    const { app, repository } = buildApp({ kyc: null });

    const response = await request(app)
      .post("/v1/investor-profile/wallet")
      .send({ wallet_address: validAddress });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("identity.kyc_required");
    expect(repository.registerWallet).not.toHaveBeenCalled();
  });

  it("reports a conflict when the address is already claimed by another account", async () => {
    const { WalletAddressConflictError } = await import(
      "../src/modules/investor-profile/repository/investor-profile.repository.js"
    );
    const { app } = buildApp({
      registerWallet: vi.fn().mockRejectedValue(new WalletAddressConflictError("address_claimed")),
    });

    const response = await request(app)
      .post("/v1/investor-profile/wallet")
      .send({ wallet_address: validAddress });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("wallet.address_already_claimed");
  });
});

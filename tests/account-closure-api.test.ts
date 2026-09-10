import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createAccountClosureRouter } from "../src/modules/auth/api/account-closure.router.js";
import {
  CancelAccountClosureService,
  RequestAccountClosureService,
} from "../src/modules/auth/application/account-closure.service.js";
import type { AccountClosureRepository, AccountClosureRequestRecord } from "../src/modules/auth/repository/account-closure.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

function pendingRequest(overrides: Partial<AccountClosureRequestRecord> = {}): AccountClosureRequestRecord {
  return {
    id: "closure_request_01",
    accountId: "acct_01",
    status: "pending",
    reason: "No longer investing",
    requestedAt: new Date("2026-09-05T12:00:00.000Z"),
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    ...overrides,
  };
}

function appFor(population: "customer" | "staff_partner", repository: AccountClosureRepository) {
  const app = express();
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = { accountId: "acct_01", providerSessionId: "session_01", population };
    next();
  };
  app.use(express.json());
  app.use(requestContext);
  app.use(
    "/v1/auth/account-closure",
    createAccountClosureRouter(
      authenticated,
      new RequestAccountClosureService(repository),
      new CancelAccountClosureService(repository),
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("account closure API", () => {
  it("submits a closure request for the authenticated customer", async () => {
    const repository: AccountClosureRepository = {
      findTarget: vi.fn().mockResolvedValue({ accountId: "acct_01", betterAuthUserId: "auth_01", status: "active" }),
      findPendingForAccount: vi.fn().mockResolvedValue(null),
      findRequest: vi.fn(),
      create: vi.fn().mockResolvedValue(pendingRequest()),
      cancel: vi.fn(),
      listPending: vi.fn(),
      decide: vi.fn(),
    };

    const response = await request(appFor("customer", repository))
      .post("/v1/auth/account-closure")
      .send({ reason: "No longer investing" });

    expect(response.status).toBe(201);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_01", reason: "No longer investing" }),
    );
    expect(response.body.data).toMatchObject({ status: "pending", account_id: "acct_01" });
  });

  it("rejects closure requests from staff identities", async () => {
    const repository: AccountClosureRepository = {
      findTarget: vi.fn(),
      findPendingForAccount: vi.fn(),
      findRequest: vi.fn(),
      create: vi.fn(),
      cancel: vi.fn(),
      listPending: vi.fn(),
      decide: vi.fn(),
    };

    const response = await request(appFor("staff_partner", repository)).post("/v1/auth/account-closure");

    expect(response.status).toBe(403);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("cancels the caller's own pending request", async () => {
    const repository: AccountClosureRepository = {
      findTarget: vi.fn(),
      findPendingForAccount: vi.fn().mockResolvedValue(pendingRequest()),
      findRequest: vi.fn(),
      create: vi.fn(),
      cancel: vi.fn().mockResolvedValue(pendingRequest({ status: "cancelled" })),
      listPending: vi.fn(),
      decide: vi.fn(),
    };

    const response = await request(appFor("customer", repository)).post("/v1/auth/account-closure/cancel");

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("cancelled");
  });
});

import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createAccountClosureOperationsRouter } from "../src/modules/auth/api/account-closure-operations.router.js";
import {
  DecideAccountClosureRequestService,
  ListPendingAccountClosureRequestsService,
} from "../src/modules/auth/application/account-closure.service.js";
import type { AccountClosureRepository, AccountClosureRequestRecord } from "../src/modules/auth/repository/account-closure.repository.js";
import type { CustomerAccountAdministrator } from "../src/modules/auth/application/customer-account-administrator.js";
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

function appFor(repository: AccountClosureRepository, administrator: CustomerAccountAdministrator) {
  const app = express();
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = {
      accountId: "acct_staff",
      providerSessionId: "session_staff",
      population: "staff_partner",
    };
    next();
  };
  const passthrough: RequestHandler = (_request, _response, next) => next();
  app.use(express.json());
  app.use(requestContext);
  app.use(
    "/internal/v1/account-closure-requests",
    createAccountClosureOperationsRouter(
      authenticated,
      passthrough,
      passthrough,
      new ListPendingAccountClosureRequestsService(repository),
      new DecideAccountClosureRequestService(repository, administrator),
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("account closure operations API", () => {
  it("lists pending closure requests", async () => {
    const repository: AccountClosureRepository = {
      findTarget: vi.fn(),
      findPendingForAccount: vi.fn(),
      findRequest: vi.fn(),
      create: vi.fn(),
      cancel: vi.fn(),
      listPending: vi.fn().mockResolvedValue([pendingRequest()]),
      decide: vi.fn(),
    };
    const administrator: CustomerAccountAdministrator = {
      revokeAllSessions: vi.fn(),
      sendRecoveryCompletionEmail: vi.fn(),
      prepareSelfServicePasskeyReplacement: vi.fn(),
      revokeSessionsForRecoveryCompletion: vi.fn(),
      clearRecoveryRequired: vi.fn(),
    };

    const response = await request(appFor(repository, administrator)).get(
      "/internal/v1/account-closure-requests",
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({ status: "pending", account_id: "acct_01" });
  });

  it("approves a request and revokes the customer's sessions", async () => {
    const repository: AccountClosureRepository = {
      findTarget: vi.fn().mockResolvedValue({ accountId: "acct_01", betterAuthUserId: "auth_01", status: "active" }),
      findPendingForAccount: vi.fn(),
      findRequest: vi.fn().mockResolvedValue(pendingRequest()),
      create: vi.fn(),
      cancel: vi.fn(),
      listPending: vi.fn(),
      decide: vi.fn().mockResolvedValue(pendingRequest({ status: "approved", resolvedBy: "acct_staff" })),
    };
    const revokeAllSessions = vi.fn().mockResolvedValue(undefined);
    const administrator: CustomerAccountAdministrator = {
      revokeAllSessions,
      sendRecoveryCompletionEmail: vi.fn(),
      prepareSelfServicePasskeyReplacement: vi.fn(),
      revokeSessionsForRecoveryCompletion: vi.fn(),
      clearRecoveryRequired: vi.fn(),
    };

    const response = await request(appFor(repository, administrator))
      .post("/internal/v1/account-closure-requests/closure_request_01/decision")
      .send({ decision: "approved", note: "Confirmed with customer" });

    expect(response.status).toBe(200);
    expect(revokeAllSessions).toHaveBeenCalledWith("auth_01");
    expect(response.body.data).toMatchObject({ status: "approved", resolved_by: "acct_staff" });
  });

  it("rejects a request without touching sessions", async () => {
    const repository: AccountClosureRepository = {
      findTarget: vi.fn(),
      findPendingForAccount: vi.fn(),
      findRequest: vi.fn().mockResolvedValue(pendingRequest()),
      create: vi.fn(),
      cancel: vi.fn(),
      listPending: vi.fn(),
      decide: vi.fn().mockResolvedValue(pendingRequest({ status: "rejected" })),
    };
    const revokeAllSessions = vi.fn();
    const administrator: CustomerAccountAdministrator = {
      revokeAllSessions,
      sendRecoveryCompletionEmail: vi.fn(),
      prepareSelfServicePasskeyReplacement: vi.fn(),
      revokeSessionsForRecoveryCompletion: vi.fn(),
      clearRecoveryRequired: vi.fn(),
    };

    const response = await request(appFor(repository, administrator))
      .post("/internal/v1/account-closure-requests/closure_request_01/decision")
      .send({ decision: "rejected" });

    expect(response.status).toBe(200);
    expect(revokeAllSessions).not.toHaveBeenCalled();
    expect(response.body.data.status).toBe("rejected");
  });
});

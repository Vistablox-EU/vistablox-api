import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createRequireAuthentication } from "../src/modules/auth/api/require-authentication.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const identity = {
  betterAuthUserId: "user_01",
  providerSessionId: "session_01",
  population: "customer" as const,
};

function buildApp(rateLimiter?: RequestHandler) {
  const sessions: SessionResolver = { resolve: vi.fn().mockResolvedValue(identity) };
  const accounts: AccountRepository = {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({ accountId: "acct_01", status: "active" }),
    hasActiveStaffRole: vi.fn(),
    hasAnyActiveStaffRole: vi.fn(),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn(),
  };
  const requireAuthentication = createRequireAuthentication(sessions, accounts, rateLimiter);

  const app = express();
  app.use(requestContext);
  app.get("/protected", requireAuthentication, (_request, response) =>
    response.json({ accountId: response.locals.authContext?.accountId }),
  );
  app.use(errorHandler);
  return app;
}

describe("require authentication", () => {
  it("resolves the account context and proceeds when no rate limiter is configured", async () => {
    const response = await request(buildApp()).get("/protected");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accountId: "acct_01" });
  });

  it("runs the rate limiter after the account context is set, so it can key by account_id", async () => {
    let observedAccountId: string | undefined;
    const rateLimiter: RequestHandler = (_request, response, next) => {
      observedAccountId = response.locals.authContext?.accountId;
      next();
    };

    const response = await request(buildApp(rateLimiter)).get("/protected");

    expect(response.status).toBe(200);
    expect(observedAccountId).toBe("acct_01");
  });

  it("propagates a 429 raised by the rate limiter through the stable error envelope", async () => {
    const rateLimiter: RequestHandler = (_request, _response, next) => {
      next(
        new AppError({
          code: "rate_limit.exceeded",
          title: "Too many requests",
          status: 429,
          detail: "Too many requests. Please slow down and try again shortly.",
        }),
      );
    };

    const response = await request(buildApp(rateLimiter)).get("/protected");

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ code: "rate_limit.exceeded", status: 429 });
  });
});

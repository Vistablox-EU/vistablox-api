import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import { createRequireAuthentication } from "../src/modules/auth/api/require-authentication.js";
import {
  reauthRequiredError,
  type AuthenticatedIdentity,
  type SessionResolver,
} from "../src/modules/auth/application/session-resolver.js";
import type { DpopReplayRepository } from "../src/modules/auth/repository/dpop-replay.repository.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const unboundIdentity: AuthenticatedIdentity = {
  betterAuthUserId: "user_01",
  providerSessionId: "session_01",
  population: "customer",
  dpopJkt: null,
  sessionCreatedAt: new Date("2026-09-11T12:00:00.000Z"),
};

function accounts(status = "active"): AccountRepository {
  return {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({ accountId: "acct_01", status }),
    hasActiveStaffRole: vi.fn(),
    hasAnyActiveStaffRole: vi.fn(),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn(),
  } as unknown as AccountRepository;
}

function buildApp(
  sessions: SessionResolver,
  accountRepository = accounts(),
  withDpop = false,
  rateLimiter?: RequestHandler,
) {
  const replayRepository: DpopReplayRepository = {
    recordProof: vi.fn().mockResolvedValue(true),
    pruneExpired: vi.fn().mockResolvedValue(0),
  };
  const requireAuthentication = createRequireAuthentication(
    sessions,
    accountRepository,
    rateLimiter,
    withDpop ? { baseUrl: "http://localhost:3000", replayRepository } : undefined,
  );
  const app = express();
  app.use(requestContext);
  app.get("/protected", requireAuthentication, (_request, response) => response.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe("requireAuthentication: activity and the rate limiter", () => {
  it("does not count a rate-limited (429) request as activity", async () => {
    const recordActivity = vi.fn().mockResolvedValue(undefined);
    const sessions: SessionResolver = { resolve: vi.fn().mockResolvedValue(unboundIdentity), recordActivity };
    const limiter: RequestHandler = (_request, _response, next) => {
      next(new AppError({ code: "rate_limit.exceeded", title: "Too many requests", status: 429, detail: "x" }));
    };

    const response = await request(buildApp(sessions, accounts(), false, limiter)).get("/protected");

    expect(response.status).toBe(429);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("counts the request as activity once the rate limiter lets it through", async () => {
    const recordActivity = vi.fn().mockResolvedValue(undefined);
    const sessions: SessionResolver = { resolve: vi.fn().mockResolvedValue(unboundIdentity), recordActivity };
    const limiter: RequestHandler = (_request, _response, next) => next();

    const response = await request(buildApp(sessions, accounts(), false, limiter)).get("/protected");

    expect(response.status).toBe(200);
    expect(recordActivity).toHaveBeenCalledTimes(1);
  });
});

describe("requireAuthentication: device session time limits", () => {
  it("answers 401 REAUTH_REQUIRED in the documented error envelope", async () => {
    const sessions: SessionResolver = { resolve: vi.fn().mockRejectedValue(reauthRequiredError()) };

    const response = await request(buildApp(sessions)).get("/protected");

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      type: "https://api.vistablox.io/errors/REAUTH_REQUIRED",
      code: "REAUTH_REQUIRED",
      status: 401,
      title: expect.any(String),
      detail: expect.any(String),
      trace_id: expect.any(String),
    });
  });

  it("records activity once the request is fully authenticated", async () => {
    const recordActivity = vi.fn().mockResolvedValue(undefined);
    const sessions: SessionResolver = {
      resolve: vi.fn().mockResolvedValue(unboundIdentity),
      recordActivity,
    };

    const response = await request(buildApp(sessions)).get("/protected");

    expect(response.status).toBe(200);
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity).toHaveBeenCalledWith(unboundIdentity);
  });

  it("does not record activity when the bound session's DPoP proof is missing", async () => {
    const recordActivity = vi.fn();
    const sessions: SessionResolver = {
      resolve: vi.fn().mockResolvedValue({ ...unboundIdentity, dpopJkt: "jkt_01" }),
      recordActivity,
    };

    const response = await request(buildApp(sessions, accounts(), true)).get("/protected");

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("DPOP_PROOF_MISSING");
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("does not record activity for a restricted account", async () => {
    const recordActivity = vi.fn();
    const sessions: SessionResolver = {
      resolve: vi.fn().mockResolvedValue(unboundIdentity),
      recordActivity,
    };

    const response = await request(buildApp(sessions, accounts("suspended"))).get("/protected");

    expect(response.status).toBe(403);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("still serves a fully authenticated request when the activity write fails", async () => {
    const recordActivity = vi.fn().mockRejectedValue(new Error("auth_session unavailable"));
    const sessions: SessionResolver = {
      resolve: vi.fn().mockResolvedValue(unboundIdentity),
      recordActivity,
    };

    const response = await request(buildApp(sessions)).get("/protected");

    expect(response.status).toBe(200);
    expect(recordActivity).toHaveBeenCalledTimes(1);
  });
});

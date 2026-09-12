import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createRequireFreshAuthentication } from "../src/modules/auth/api/require-fresh-authentication.js";
import type { CustomerSessionRepository } from "../src/modules/auth/repository/customer-session.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");

function appFor(sessionCreatedAt: Date) {
  const sessions: CustomerSessionRepository = {
    listForAccount: vi.fn(),
    findOwnedSessionToken: vi.fn(),
    hasFreshAuthentication: vi.fn().mockResolvedValue(false),
  };
  const app = express();
  app.use(requestContext);
  app.get(
    "/protected",
    (_request, response, next) => {
      response.locals.authContext = {
        accountId: "acct_01",
        providerSessionId: "session_01",
        population: "customer",
        authenticationLevel: "device_biometric",
        sessionCreatedAt,
      };
      next();
    },
    createRequireFreshAuthentication(sessions, () => NOW),
    (_request, response) => response.json({ ok: true }),
  );
  app.use(errorHandler);
  return { app, sessions };
}

describe("require fresh authentication", () => {
  it("accepts a device-biometric session created within the fresh-auth window", async () => {
    const { app, sessions } = appFor(new Date(NOW.getTime() - 4 * 60_000));

    const response = await request(app).get("/protected");

    expect(response.status).toBe(200);
    expect(sessions.hasFreshAuthentication).not.toHaveBeenCalled();
  });

  it("does not treat an older device-biometric session as fresh", async () => {
    const { app, sessions } = appFor(new Date(NOW.getTime() - 5 * 60_000 - 1));

    const response = await request(app).get("/protected");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authentication.fresh_auth_required");
    expect(sessions.hasFreshAuthentication).toHaveBeenCalledWith({
      accountId: "acct_01",
      providerSessionId: "session_01",
      freshAfter: new Date(NOW.getTime() - 5 * 60_000),
    });
  });
});

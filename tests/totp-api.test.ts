import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createTotpRouter } from "../src/modules/auth/api/totp.router.js";
import { EnrollTotpService, VerifyTotpService } from "../src/modules/auth/application/totp.service.js";
import type { TotpProvider } from "../src/modules/auth/infrastructure/otplib-totp.provider.js";
import type { TotpRepository } from "../src/modules/auth/repository/totp.repository.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const repository: TotpRepository = {
  getAccountLabel: vi.fn().mockResolvedValue("investor@example.com"),
  getFactor: vi.fn().mockResolvedValue({
    accountId: "acct_01",
    secret: "SECRET123",
    enrolledAt: new Date("2026-08-01T00:00:00.000Z"),
    lastUsedAt: null,
  }),
  enroll: vi.fn().mockResolvedValue(undefined),
  recordTotpUse: vi.fn().mockResolvedValue(undefined),
};
const provider: TotpProvider = {
  generateSecret: vi.fn().mockReturnValue("SECRET123"),
  verify: vi.fn().mockResolvedValue(true),
  buildOtpAuthUri: vi.fn().mockReturnValue("otpauth://totp/VistaBlox:investor@example.com?secret=SECRET123"),
};

function appFor(
  population: "customer" | "staff_partner",
  requireFreshAuthentication?: RequestHandler,
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
  app.use(requestContext);
  app.use(express.json());
  app.use(
    "/v1/auth/totp",
    createTotpRouter(
      authenticated,
      new EnrollTotpService(repository, provider),
      new VerifyTotpService(repository, provider),
      requireFreshAuthentication,
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("TOTP API", () => {
  it("enrolls a customer and returns the otpauth URI and secret once, with no backup codes", async () => {
    const response = await request(appFor("customer")).post("/v1/auth/totp/enroll");

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data.otp_auth_uri).toContain("otpauth://");
    expect(response.body.data).not.toHaveProperty("backup_codes");
  });

  it("verifies a code for a customer", async () => {
    const response = await request(appFor("customer"))
      .post("/v1/auth/totp/verify")
      .send({ code: "123456" });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ verified: true, method: "totp" });
  });

  it("does not enroll or replace an authenticator without fresh authentication", async () => {
    const before = vi.mocked(repository.enroll).mock.calls.length;
    const requireFresh: RequestHandler = (_request, _response, next) => {
      next(
        new AppError({
          code: "authentication.fresh_auth_required",
          title: "Fresh authentication required",
          status: 403,
          detail: "Confirm with a passkey before continuing.",
        }),
      );
    };

    const response = await request(appFor("customer", requireFresh)).post(
      "/v1/auth/totp/enroll",
    );

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authentication.fresh_auth_required");
    expect(vi.mocked(repository.enroll).mock.calls).toHaveLength(before);
  });

  it("rejects an invalid verify body", async () => {
    const response = await request(appFor("customer"))
      .post("/v1/auth/totp/verify")
      .send({ code: "1" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("validation.invalid_field");
  });

  it("does not expose customer TOTP enrollment to staff identities", async () => {
    const response = await request(appFor("staff_partner")).post("/v1/auth/totp/enroll");

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "authorization.forbidden", status: 403 });
  });
});

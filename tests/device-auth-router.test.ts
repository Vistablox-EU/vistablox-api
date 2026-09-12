import express, { type RequestHandler } from "express";
import request from "supertest";
import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";

import { createAppConfigRouter, createDeviceAuthRouter } from "../src/modules/auth/api/device-auth.router.js";
import { IssueDeviceChallengeService } from "../src/modules/auth/application/device-challenge-issuance.service.js";
import type { DeviceChallengeRepository } from "../src/modules/auth/repository/device-challenge.repository.js";
import type { VistaBloxAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const dpopOnly: RequestHandler = (_request, response, next) => {
  response.locals.dpopJkt = "the-request-dpop-jkt";
  next();
};

function fakeChallengeRepository(): DeviceChallengeRepository {
  return {
    issue: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue(null),
    pruneExpired: vi.fn().mockResolvedValue(0),
  };
}

function appFor(
  auth: { api: Record<string, unknown> },
  challengeRateLimiters: RequestHandler[] = [],
) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  const challenges = fakeChallengeRepository();
  const issueChallenge = new IssueDeviceChallengeService(challenges);
  app.use(
    "/v1/auth/mobile",
    createDeviceAuthRouter(
      dpopOnly,
      issueChallenge,
      auth as unknown as VistaBloxAuth,
      dpopOnly,
      challengeRateLimiters,
    ),
  );
  app.use(
    "/v1/app",
    createAppConfigRouter(dpopOnly, {
      minAppVersion: { ios: "0.0.0", android: "0.0.0" },
      features: {
        device_auth: true,
        device_enrolment_required: false,
        passkey_login: true,
        signing_requests: false,
        recovery_v2: false,
        safe_account: false,
      },
      mobileAuthPlatforms: { android: true, ios: false },
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("GET /v1/app/config", () => {
  it("returns the configured feature flags behind DPoP-only enforcement", async () => {
    const response = await request(appFor({ api: {} })).get("/v1/app/config");

    expect(response.status).toBe(200);
    expect(response.body.data.features.device_auth).toBe(true);
    expect(response.body.data.mobile_auth_platforms).toEqual({ android: true, ios: false });
  });

  it("does not keep the retired device-auth namespace mounted", async () => {
    const response = await request(appFor({ api: {} }))
      .post("/v1/auth/devices/login/challenge")
      .send({ device_id: "device_1" });

    expect(response.status).toBe(404);
  });
});

describe("POST /v1/auth/mobile/enrol/verify", () => {
  it("forwards to auth.api.enrolVerify with a request bound to this /v1 URL (DPoP htu binding)", async () => {
    const enrolVerify = vi.fn().mockResolvedValue({
      response: {
        device_id: "device_1",
        status: "active",
        session_expires_at: "2026-01-01T00:00:00.000Z",
        authentication_level: "device_biometric",
      },
      headers: new Headers({ "set-auth-token": "the-session-token" }),
    });

    const response = await request(appFor({ api: { enrolVerify } }))
      .post("/v1/auth/mobile/enrol/verify")
      .send({
        challenge: "the-challenge",
        jws: "the-jws",
        attestation: { platform: "android", key_attestation_chain: ["cert1"], integrity_token: undefined },
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      device_id: "device_1",
      status: "active",
      authentication_level: "device_biometric",
    });
    expect(response.headers["set-auth-token"]).toBe("the-session-token");

    expect(enrolVerify).toHaveBeenCalledTimes(1);
    const call = enrolVerify.mock.calls[0]![0] as { request: Request };
    // This is the regression case: auth.api.* never synthesizes a
    // ctx.request for a programmatic call, so without an explicit `request`
    // field here, requireDpopProofForSessionCreation always rejects with
    // DPOP_PROOF_MISSING -- the DPoP proof binds to this /v1 URL, not
    // better-auth's internal /api/auth mount.
    expect(call.request).toBeInstanceOf(Request);
    expect(new URL(call.request.url).pathname).toBe("/v1/auth/mobile/enrol/verify");
    expect(call.request.method).toBe("POST");
  });

  it("maps a rejected APIError to the /v1 problem+json envelope, faithfully relaying whatever status the plugin set (contract 3.6: DEVICE_CHALLENGE_EXPIRED is 400, not 401)", async () => {
    const enrolVerify = vi.fn().mockRejectedValue(
      new APIError("BAD_REQUEST", { code: "DEVICE_CHALLENGE_EXPIRED", message: "expired" }),
    );

    const response = await request(appFor({ api: { enrolVerify } }))
      .post("/v1/auth/mobile/enrol/verify")
      .send({
        challenge: "the-challenge",
        jws: "the-jws",
        attestation: { platform: "android", key_attestation_chain: ["cert1"], integrity_token: undefined },
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("DEVICE_CHALLENGE_EXPIRED");
  });
});

describe("POST /v1/auth/mobile/login/verify", () => {
  it("forwards to auth.api.loginVerify with a request bound to this /v1 URL", async () => {
    const loginVerify = vi.fn().mockResolvedValue({
      response: {
        device_id: "device_1",
        session_expires_at: "2026-01-01T00:00:00.000Z",
        authentication_level: "device_biometric",
      },
      headers: new Headers({ "set-auth-token": "the-session-token" }),
    });

    const response = await request(appFor({ api: { loginVerify } }))
      .post("/v1/auth/mobile/login/verify")
      .send({ device_id: "device_1", challenge: "the-challenge", jws: "the-jws" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      device_id: "device_1",
      authentication_level: "device_biometric",
    });
    expect(response.headers["set-auth-token"]).toBe("the-session-token");

    const call = loginVerify.mock.calls[0]![0] as { request: Request };
    expect(new URL(call.request.url).pathname).toBe("/v1/auth/mobile/login/verify");
    expect(call.request.method).toBe("POST");
  });

  it("maps a rejected APIError to the /v1 problem+json envelope", async () => {
    const loginVerify = vi.fn().mockRejectedValue(
      new APIError("UNAUTHORIZED", { code: "DEVICE_LOGIN_FAILED", message: "failed" }),
    );

    const response = await request(appFor({ api: { loginVerify } }))
      .post("/v1/auth/mobile/login/verify")
      .send({ device_id: "device_1", challenge: "the-challenge", jws: "the-jws" });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("DEVICE_LOGIN_FAILED");
  });
});

describe("L1/L2 without device_id (contract 3.1: the device comes from the DPoP key)", () => {
  it("issues a login challenge for an empty L1 body", async () => {
    const response = await request(appFor({ api: {} })).post("/v1/auth/mobile/login/challenge").send({});

    expect(response.status).toBe(200);
    expect(typeof response.body.data.challenge).toBe("string");
  });

  it("forwards an L2 without device_id, without inventing one", async () => {
    const loginVerify = vi.fn().mockResolvedValue({
      response: {
        device_id: "device_by_key",
        session_expires_at: "2026-01-01T00:00:00.000Z",
        authentication_level: "device_biometric",
      },
      headers: new Headers({ "set-auth-token": "the-session-token" }),
    });

    const response = await request(appFor({ api: { loginVerify } }))
      .post("/v1/auth/mobile/login/verify")
      .send({ challenge: "the-challenge", jws: "the-jws" });

    expect(response.status).toBe(200);
    expect(response.body.data.device_id).toBe("device_by_key");
    const call = loginVerify.mock.calls[0]![0] as { body: Record<string, unknown> };
    expect(call.body).toEqual({ challenge: "the-challenge", jws: "the-jws" });
  });
});

describe("device-auth rate limiting", () => {
  function rejectAfterFirstCall(): RequestHandler {
    let calls = 0;
    return (_request, response, next) => {
      calls++;
      if (calls > 1) {
        response.status(429).json({ code: "rate_limit.exceeded" });
        return;
      }
      next();
    };
  }

  it("applies the supplied rate limiters to /enrol/challenge and /login/challenge", async () => {
    const app = appFor({ api: {} }, [rejectAfterFirstCall()]);

    const first = await request(app).post("/v1/auth/mobile/enrol/challenge");
    const second = await request(app).post("/v1/auth/mobile/login/challenge").send({
      device_id: "device_1",
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("rate_limit.exceeded");
  });

  it("also applies the supplied rate limiters to /enrol/verify and /login/verify", async () => {
    const enrolVerify = vi.fn().mockResolvedValue({
      response: {
        device_id: "device_1",
        status: "active",
        session_expires_at: "2026-01-01T00:00:00.000Z",
        authentication_level: "device_biometric",
      },
      headers: new Headers(),
    });
    const loginVerify = vi.fn();
    // Fresh limiter instance (its own call counter) per app -- verifying
    // /login/verify inherits the limiter too, independent of /enrol/verify's.
    const app = appFor({ api: { enrolVerify, loginVerify } }, [rejectAfterFirstCall()]);

    const first = await request(app)
      .post("/v1/auth/mobile/enrol/verify")
      .send({
        challenge: "the-challenge",
        jws: "the-jws",
        attestation: { platform: "android", key_attestation_chain: ["cert1"], integrity_token: undefined },
      });
    const second = await request(app)
      .post("/v1/auth/mobile/login/verify")
      .send({ device_id: "device_1", challenge: "the-challenge", jws: "the-jws" });

    expect(first.status).toBe(200);
    expect(enrolVerify).toHaveBeenCalledTimes(1);
    expect(second.status).toBe(429);
    expect(loginVerify).not.toHaveBeenCalled();
  });
});

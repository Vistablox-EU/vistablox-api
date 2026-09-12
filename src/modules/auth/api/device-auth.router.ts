import { Router, type RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { APIError } from "better-auth/api";

import { AppError } from "../../../shared/errors/app-error.js";
import type { IssueDeviceChallengeService } from "../application/device-challenge-issuance.service.js";
import type { MobileAttestation } from "../application/mobile-attestation.schemas.js";
import type { VistaBloxAuth } from "../infrastructure/better-auth.factory.js";
import {
  appConfigResponseSchema,
  challengeResponseSchema,
  enrolVerifyRequestSchema,
  enrolVerifyResponseSchema,
  loginChallengeRequestSchema,
  loginChallengeResponseSchema,
  loginVerifyRequestSchema,
  loginVerifyResponseSchema,
} from "./device-auth.schemas.js";

const ENROL_CHALLENGE_TTL_SECONDS = 300;
const LOGIN_CHALLENGE_TTL_SECONDS = 120;

export interface AppConfigFeatures {
  device_auth: boolean;
  device_enrolment_required: boolean;
  signing_requests: boolean;
  recovery_v2: boolean;
  safe_account: boolean;
}

export interface AppConfig {
  minAppVersion: { ios: string; android: string };
  features: AppConfigFeatures;
  mobileAuthPlatforms: { android: boolean; ios: boolean };
}

// The device-auth plugin's endpoints, added to createBetterAuth's plugins
// array conditionally (only when options.deviceAuth is set) -- TypeScript
// can't carry an individual plugin's endpoint types through that
// conditional spread into VistaBloxAuth's inferred `api` shape, so this
// names just the two methods this router actually calls, cast at each call
// site below. The real runtime shape is exactly better-auth-device-auth
// .plugin.ts's own endpoint handlers; this interface must stay in sync
// with their request/response bodies by hand.
interface DeviceAuthApi {
  enrolVerify(input: {
    headers: Headers;
    body: {
      challenge: string;
      jws: string;
      attestation: MobileAttestation;
    };
    request: Request;
    asResponse: false;
    returnHeaders: true;
  }): Promise<{
    response: {
      device_id: string;
      status: "active";
      session_expires_at: string;
      authentication_level: "device_biometric";
    };
    headers: Headers;
  }>;
  loginVerify(input: {
    headers: Headers;
    body: { device_id?: string; challenge: string; jws: string };
    request: Request;
    asResponse: false;
    returnHeaders: true;
  }): Promise<{
    response: {
      device_id: string;
      session_expires_at: string;
      authentication_level: "device_biometric";
    };
    headers: Headers;
  }>;
}

// The DPoP proof presented to enrol/verify and login/verify binds to this
// request's own /v1 URL (contract, and the same convention require-dpop-only
// uses via request.originalUrl) -- but auth.api.* never synthesizes a
// `ctx.request` for a programmatic call the way a real HTTP dispatch would,
// so without this, ctx.request stays undefined and
// requireDpopProofForSessionCreation always rejects with DPOP_PROOF_MISSING.
// The origin here is a placeholder; only the constructed URL's pathname is
// ever read (dpop-session-creation.ts's buildHtu call), combined with the
// server's own configured baseUrl, never this placeholder's origin.
function requestForDpopBinding(request: import("express").Request): Request {
  return new Request(`http://device-auth.internal${request.originalUrl}`, {
    method: request.method,
  });
}

/** `/v1/app/config` (C1). */
export function createAppConfigRouter(
  requireDpopOnly: RequestHandler,
  appConfig: AppConfig,
): Router {
  const router = Router();
  router.get("/config", requireDpopOnly, (_request, response) => {
    response.json(
      appConfigResponseSchema.parse({
        data: {
          min_app_version: appConfig.minAppVersion,
          features: appConfig.features,
          mobile_auth_platforms: appConfig.mobileAuthPlatforms,
        },
      }),
    );
  });
  return router;
}

/**
 * `/v1/auth/mobile/*` (E1, E2, L1, L2). E1b and the owner-assertion path
 * aren't implemented in this PR -- `safe_account` stays `false`, so
 * `E2` only ever takes the JWS path (see the plan's "explicitly out of
 * scope" section). E2/L2 are thin: they forward to the device-auth
 * better-auth plugin (auth.api.enrolVerify / loginVerify) via a real
 * function call, not HTTP, and relay its `set-auth-token` header onto this
 * response -- the plugin endpoint does the actual verification and
 * session creation; this router only reshapes its result into the /v1
 * problem+json envelope.
 */
export function createDeviceAuthRouter(
  requireDpopOnly: RequestHandler,
  issueChallenge: IssueDeviceChallengeService,
  auth: VistaBloxAuth,
  // Used on /enrol/verify and /login/verify instead of requireDpopOnly --
  // verifies the proof and sets response.locals.dpopJkt the same way, but
  // must NOT also record (jkt, jti): the better-auth ceremony these routes
  // call into (auth.api.enrolVerify/loginVerify) does its own full
  // verify-and-record of this identical request's proof moments later, and
  // the two can't dedupe each other (see require-dpop-only.ts's
  // recordReplays doc comment for why -- the router builds a new Request
  // object for the ceremony, so its WeakMap cache never sees this
  // middleware's). Recording here too would make the ceremony's own record
  // always lose as a replay of this one -- confirmed live (DPOP_REPLAY on
  // every real E2/L2 call) before this parameter existed.
  requireDpopOnlyForVerify: RequestHandler,
  // Applied after requireDpopOnly (so a DPoP-keyed limiter -- see
  // rate-limit.ts's dpopKeyRateLimitSubject -- can read response.locals
  // .dpopJkt) to all four routes: challenge issuance writes a fresh,
  // unauthenticated device_challenges row on every call with no other
  // gate, and verify is worth limiting too even though it's gated by
  // holding a single-use challenge (brute-forcing a JWS/attestation
  // shouldn't be free just because it fails). Empty by default so a
  // caller with no rateLimitStore configured (e.g. most tests) gets
  // no-op middleware.
  deviceAuthRateLimiters: RequestHandler[] = [],
): Router {
  const router = Router();

  router.post("/enrol/challenge", requireDpopOnly, ...deviceAuthRateLimiters, async (_request, response) => {
    const dpopJkt = requireDpopJkt(response);
    const { challenge, expiresAt } = await issueChallenge.execute({
      purpose: "enrol-device",
      dpopJkt,
      deviceId: undefined,
      ttlSeconds: ENROL_CHALLENGE_TTL_SECONDS,
    });
    response.json(
      challengeResponseSchema.parse({
        data: { challenge, expires_at: expiresAt.toISOString() },
      }),
    );
  });

  router.post("/enrol/verify", requireDpopOnlyForVerify, ...deviceAuthRateLimiters, async (request, response) => {
    const body = enrolVerifyRequestSchema.parse(request.body);
    try {
      const { response: result, headers } = await (auth.api as unknown as DeviceAuthApi).enrolVerify({
        headers: fromNodeHeaders(request.headers),
        body: { challenge: body.challenge, jws: body.jws, attestation: body.attestation },
        request: requestForDpopBinding(request),
        // Without this, better-auth's dispatch sees a real Request object
        // (isRequestLike) and defaults shouldReturnResponse to true,
        // returning a fetch Response instead of { response, headers } --
        // destructuring `.response` off a Response is always undefined, so
        // this crashed with a 500 on EVERY call, success or failure, until
        // this was added. Confirmed against better-auth's own dispatch.mjs
        // directly, not guessed.
        asResponse: false,
        returnHeaders: true,
      });
      relaySetAuthToken(response, headers);
      response.json(
        enrolVerifyResponseSchema.parse({
          data: {
            device_id: result.device_id,
            status: result.status,
            session_expires_at: result.session_expires_at,
            authentication_level: result.authentication_level,
          },
        }),
      );
    } catch (error) {
      throw toAppError(error);
    }
  });

  router.post("/login/challenge", requireDpopOnly, ...deviceAuthRateLimiters, async (request, response) => {
    const dpopJkt = requireDpopJkt(response);
    const body = loginChallengeRequestSchema.parse(request.body ?? {});
    const { challenge, expiresAt } = await issueChallenge.issueLoginChallenge({
      dpopJkt,
      deviceId: body.device_id,
      ttlSeconds: LOGIN_CHALLENGE_TTL_SECONDS,
    });
    response.json(
      loginChallengeResponseSchema.parse({
        data: {
          challenge,
          expires_at: expiresAt.toISOString(),
          // Re-attestation isn't implemented in this PR -- always false.
          attestation_required: false,
        },
      }),
    );
  });

  router.post("/login/verify", requireDpopOnlyForVerify, ...deviceAuthRateLimiters, async (request, response) => {
    const body = loginVerifyRequestSchema.parse(request.body);
    try {
      const { response: result, headers } = await (auth.api as unknown as DeviceAuthApi).loginVerify({
        headers: fromNodeHeaders(request.headers),
        body: {
          ...(body.device_id === undefined ? {} : { device_id: body.device_id }),
          challenge: body.challenge,
          jws: body.jws,
        },
        request: requestForDpopBinding(request),
        // See the identical comment on enrolVerify's call above.
        asResponse: false,
        returnHeaders: true,
      });
      relaySetAuthToken(response, headers);
      response.json(
        loginVerifyResponseSchema.parse({
          data: {
            device_id: result.device_id,
            session_expires_at: result.session_expires_at,
            authentication_level: result.authentication_level,
          },
        }),
      );
    } catch (error) {
      throw toAppError(error);
    }
  });

  return router;
}

function requireDpopJkt(response: import("express").Response): string {
  const jkt = response.locals.dpopJkt;
  if (typeof jkt !== "string") {
    throw new AppError({
      code: "internal.dpop_jkt_missing",
      title: "Internal server error",
      status: 500,
      detail: "requireDpopOnly ran but left no DPoP jkt for the handler to use.",
    });
  }
  return jkt;
}

function relaySetAuthToken(
  response: import("express").Response,
  headers: Headers | undefined,
): void {
  const token = headers?.get("set-auth-token");
  if (token !== null && token !== undefined) {
    response.setHeader("set-auth-token", token);
  }
}

function toAppError(error: unknown): AppError {
  if (error instanceof APIError) {
    const code = typeof error.body?.code === "string" ? error.body.code : "device_auth.failed";
    const message =
      typeof error.body?.message === "string" ? error.body.message : "Device authentication failed.";
    return new AppError({
      code,
      title: message,
      status: error.statusCode,
      detail: message,
      cause: error,
    });
  }
  if (error instanceof AppError) return error;
  return new AppError({
    code: "internal.unexpected",
    title: "Internal server error",
    status: 500,
    detail: "An unexpected error occurred.",
    cause: error,
  });
}

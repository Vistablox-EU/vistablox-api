import { randomBytes } from "node:crypto";

import express from "express";
import { APIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createRequireDpopOnly } from "../src/modules/auth/api/require-dpop-only.js";
import {
  assertDpopKeyMatchesPendingSession,
  requireDpopProofForSessionCreation,
  type DpopCreationContext,
  type DpopSessionCreationOptions,
} from "../src/modules/auth/infrastructure/dpop-session-creation.js";
import type { DpopReplayRepository } from "../src/modules/auth/repository/dpop-replay.repository.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

// Mirrors device-auth.router.ts's own toAppError: the real router catches
// the ceremony's APIError and translates it before the generic
// errorHandler ever sees it. This test's handler does the same, so a
// DpopReplayError surfaces as 401/DPOP_REPLAY here exactly like it would
// through the real /v1 route, not as an unhandled 500.
function toAppError(error: unknown): AppError {
  if (error instanceof APIError) {
    const code = typeof error.body?.code === "string" ? error.body.code : "device_auth.failed";
    const message =
      typeof error.body?.message === "string" ? error.body.message : "Device authentication failed.";
    return new AppError({ code, title: message, status: error.statusCode, detail: message, cause: error });
  }
  return new AppError({
    code: "internal.unexpected",
    title: "Internal server error",
    status: 500,
    detail: "An unexpected error occurred.",
    cause: error,
  });
}

const BASE_URL = "https://api.vistablox.io";
const PATH = "/v1/auth/devices/enrol/verify";

async function keypair(): Promise<{ privateKey: CryptoKey; publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk };
}

async function buildProof(options: { privateKey: CryptoKey; publicJwk: JWK }): Promise<string> {
  return new SignJWT({
    htm: "POST",
    htu: `${BASE_URL}${PATH}`,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(16).toString("base64url"),
  })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: options.publicJwk as Record<string, unknown> })
    .sign(options.privateKey);
}

function inMemoryReplayRepository(): DpopReplayRepository {
  const seen = new Set<string>();
  return {
    recordProof: vi.fn(async (jkt: string, jti: string) => {
      const key = `${jkt}:${jti}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    pruneExpired: vi.fn().mockResolvedValue(0),
  };
}

// Same construction the real router uses (requestForDpopBinding in
// device-auth.router.ts) -- a fresh Request object per call, so the
// ceremony's WeakMap-based single-flight cache (dpop-session-creation.ts)
// never sees whatever Express's own request object was. That's exactly
// why requireDpopOnly recording here (rather than verify-only) collides
// with the ceremony's own record: there's no shared object identity for
// either side to detect "this was already handled this request."
function ceremonyContext(request: import("express").Request): DpopCreationContext {
  return {
    headers: fromNodeHeaders(request.headers),
    request: new Request(`${BASE_URL}${request.originalUrl}`, { method: request.method }),
    path: request.originalUrl,
  };
}

function appWithMiddlewareThenCeremony(
  dpopOnlyMiddleware: express.RequestHandler,
  dpop: DpopSessionCreationOptions,
  mode: "enrol-style" | "login-style",
  boundJkt?: string,
) {
  const app = express();
  app.use(requestContext);
  app.post(PATH, dpopOnlyMiddleware, async (req, res, next) => {
    try {
      const ctx = ceremonyContext(req);
      if (mode === "enrol-style") {
        // Mirrors enrolVerify: a pre-bound pending session's key must match
        // this request's proof -- assertDpopKeyMatchesPendingSession does
        // the ceremony's own full verify-and-record.
        await assertDpopKeyMatchesPendingSession(ctx, boundJkt!, dpop);
      } else {
        // Mirrors loginVerify: no pending session, just requires and
        // verifies-and-records this request's own proof.
        await requireDpopProofForSessionCreation(ctx, dpop);
      }
      res.json({ ok: true });
    } catch (error) {
      next(toAppError(error));
    }
  });
  app.use(errorHandler);
  return app;
}

// This is the exact chain the real /v1/auth/devices/enrol/verify and
// .../login/verify routes run: requireDpopOnly(ForVerify) as Express
// middleware, then -- inside the handler, via auth.api.enrolVerify/
// loginVerify -- the better-auth ceremony's own DPoP check
// (assertDpopKeyMatchesPendingSession / requireDpopProofForSessionCreation),
// both against the SAME DpopReplayRepository instance the real app wires
// them to share (server.ts). No stubbed auth.api here: this is the real
// middleware and the real ceremony functions, chained the same way.
describe("E2/L2's real requireDpopOnly -> ceremony DPoP chain, one shared replay repository", () => {
  it("BEFORE THE FIX (requireDpopOnly recording enabled on a verify route) double-records and fails with DPOP_REPLAY -- documents the bug this PR fixes", async () => {
    const replayRepository = inMemoryReplayRepository();
    const dpop: DpopSessionCreationOptions = { baseUrl: BASE_URL, replayRepository };
    const { privateKey, publicJwk } = await keypair();
    const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
    const proof = await buildProof({ privateKey, publicJwk });

    // The old configuration: a requireDpopOnly instance that records
    // replays, used on a route whose handler also runs a ceremony that
    // records the same proof again.
    const buggyRequireDpopOnly = createRequireDpopOnly({ baseUrl: BASE_URL, replayRepository });
    const app = appWithMiddlewareThenCeremony(buggyRequireDpopOnly, dpop, "enrol-style", jkt);

    const response = await request(app).post(PATH).set("dpop", proof);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("DPOP_REPLAY");
  });

  it("AFTER THE FIX (requireDpopOnlyForVerify, recordReplays: false) succeeds for E2's chain (assertDpopKeyMatchesPendingSession)", async () => {
    const replayRepository = inMemoryReplayRepository();
    const dpop: DpopSessionCreationOptions = { baseUrl: BASE_URL, replayRepository };
    const { privateKey, publicJwk } = await keypair();
    const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
    const proof = await buildProof({ privateKey, publicJwk });

    const requireDpopOnlyForVerify = createRequireDpopOnly({
      baseUrl: BASE_URL,
      replayRepository,
      recordReplays: false,
    });
    const app = appWithMiddlewareThenCeremony(requireDpopOnlyForVerify, dpop, "enrol-style", jkt);

    const response = await request(app).post(PATH).set("dpop", proof);

    expect(response.status).toBe(200);
    expect(replayRepository.recordProof).toHaveBeenCalledTimes(1);
  });

  it("AFTER THE FIX, succeeds for L2's chain (requireDpopProofForSessionCreation)", async () => {
    const replayRepository = inMemoryReplayRepository();
    const dpop: DpopSessionCreationOptions = { baseUrl: BASE_URL, replayRepository };
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk });

    const requireDpopOnlyForVerify = createRequireDpopOnly({
      baseUrl: BASE_URL,
      replayRepository,
      recordReplays: false,
    });
    const app = appWithMiddlewareThenCeremony(requireDpopOnlyForVerify, dpop, "login-style");

    const response = await request(app).post(PATH).set("dpop", proof);

    expect(response.status).toBe(200);
    expect(replayRepository.recordProof).toHaveBeenCalledTimes(1);
  });

  it("a genuinely different, later request replaying the identical proof is still rejected", async () => {
    const replayRepository = inMemoryReplayRepository();
    const dpop: DpopSessionCreationOptions = { baseUrl: BASE_URL, replayRepository };
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk });

    const requireDpopOnlyForVerify = createRequireDpopOnly({
      baseUrl: BASE_URL,
      replayRepository,
      recordReplays: false,
    });
    const app = appWithMiddlewareThenCeremony(requireDpopOnlyForVerify, dpop, "login-style");

    const first = await request(app).post(PATH).set("dpop", proof);
    const second = await request(app).post(PATH).set("dpop", proof);

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(second.body.code).toBe("DPOP_REPLAY");
  });
});

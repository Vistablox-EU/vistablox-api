import { randomBytes, createHash } from "node:crypto";

import express from "express";
import request from "supertest";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  createRequireAuthentication,
  type DpopEnforcementOptions,
} from "../src/modules/auth/api/require-authentication.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { AuthenticatedIdentity, SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import type { DpopReplayRepository } from "../src/modules/auth/repository/dpop-replay.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const BASE_URL = "https://api.vistablox.io";
const ROUTE = "/protected/resource";
const HTU = `${BASE_URL}${ROUTE}`;
const BEARER_TOKEN = "the-bearer-token";

async function keypair(): Promise<{ privateKey: CryptoKey; publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk };
}

async function buildProof(options: {
  privateKey: CryptoKey;
  publicJwk: JWK;
  method?: string;
  htu?: string;
  iat?: number;
  jti?: string;
  bearerToken?: string | undefined;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    htm: options.method ?? "GET",
    htu: options.htu ?? HTU,
    iat: options.iat ?? Math.floor(Date.now() / 1000),
    jti: options.jti ?? randomBytes(16).toString("base64url"),
  };
  const bearerToken = "bearerToken" in options ? options.bearerToken : BEARER_TOKEN;
  if (bearerToken !== undefined) {
    payload.ath = createHash("sha256").update(bearerToken, "ascii").digest("base64url");
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: options.publicJwk as Record<string, unknown> })
    .sign(options.privateKey);
}

function buildAccounts(): AccountRepository {
  return {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({ accountId: "acct_01", status: "active" }),
    hasActiveStaffRole: vi.fn(),
    hasAnyActiveStaffRole: vi.fn(),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn(),
  };
}

function buildReplayRepository(overrides: Partial<DpopReplayRepository> = {}): DpopReplayRepository {
  return {
    recordProof: vi.fn().mockResolvedValue(true),
    pruneExpired: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function buildApp(options: {
  identity: AuthenticatedIdentity;
  dpop?: DpopEnforcementOptions;
  bindDpopKey?: SessionResolver["bindDpopKey"];
}) {
  const sessions: SessionResolver = {
    resolve: vi.fn().mockResolvedValue(options.identity),
    ...(options.bindDpopKey === undefined ? {} : { bindDpopKey: options.bindDpopKey }),
  };
  const requireAuthentication = createRequireAuthentication(
    sessions,
    buildAccounts(),
    undefined,
    options.dpop,
  );

  const app = express();
  app.use(requestContext);
  app.get(ROUTE, requireAuthentication, (_request, response) =>
    response.json({ ok: true }),
  );
  app.use(errorHandler);
  return app;
}

function boundIdentity(dpopJkt: string): AuthenticatedIdentity {
  return {
    betterAuthUserId: "user_01",
    providerSessionId: "session_01",
    population: "customer",
    dpopJkt,
    sessionCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function unboundIdentity(sessionCreatedAt: Date): AuthenticatedIdentity {
  return {
    betterAuthUserId: "user_01",
    providerSessionId: "session_01",
    population: "customer",
    dpopJkt: null,
    sessionCreatedAt,
  };
}

describe("require authentication: bound session DPoP enforcement", () => {
  it("passes through a bound session with a valid, matching proof", async () => {
    const { privateKey, publicJwk } = await keypair();
    // jkt is deterministic from the jwk alone (RFC 7638) -- bind identity to
    // this exact key by computing it the same way the verifier will.
    const { calculateJwkThumbprint } = await import("jose");
    const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
    const proof = await buildProof({ privateKey, publicJwk });
    const replayRepository = buildReplayRepository();

    const app = buildApp({
      identity: boundIdentity(jkt),
      dpop: { baseUrl: BASE_URL, replayRepository },
    });

    const response = await request(app)
      .get(ROUTE)
      .set("Authorization", `Bearer ${BEARER_TOKEN}`)
      .set("DPoP", proof);

    expect(response.status).toBe(200);
    expect(replayRepository.recordProof).toHaveBeenCalledWith(jkt, expect.any(String), expect.any(Date));
  });

  it("rejects a bound session with no proof", async () => {
    const { publicJwk } = await keypair();
    const { calculateJwkThumbprint } = await import("jose");
    const jkt = await calculateJwkThumbprint(publicJwk, "sha256");

    const app = buildApp({
      identity: boundIdentity(jkt),
      dpop: { baseUrl: BASE_URL, replayRepository: buildReplayRepository() },
    });

    const response = await request(app).get(ROUTE).set("Authorization", `Bearer ${BEARER_TOKEN}`);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("DPOP_PROOF_MISSING");
    expect(response.headers["www-authenticate"]).toContain("DPoP");
  });

  it("rejects a bound session when the proof's key doesn't match", async () => {
    const bound = await keypair();
    const attacker = await keypair();
    const { calculateJwkThumbprint } = await import("jose");
    const boundJkt = await calculateJwkThumbprint(bound.publicJwk, "sha256");
    const proof = await buildProof({ privateKey: attacker.privateKey, publicJwk: attacker.publicJwk });

    const app = buildApp({
      identity: boundIdentity(boundJkt),
      dpop: { baseUrl: BASE_URL, replayRepository: buildReplayRepository() },
    });

    const response = await request(app)
      .get(ROUTE)
      .set("Authorization", `Bearer ${BEARER_TOKEN}`)
      .set("DPoP", proof);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("DPOP_KEY_MISMATCH");
  });

  it("rejects a replayed proof on a bound session", async () => {
    const { privateKey, publicJwk } = await keypair();
    const { calculateJwkThumbprint } = await import("jose");
    const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
    const proof = await buildProof({ privateKey, publicJwk });
    const replayRepository = buildReplayRepository({ recordProof: vi.fn().mockResolvedValue(false) });

    const app = buildApp({
      identity: boundIdentity(jkt),
      dpop: { baseUrl: BASE_URL, replayRepository },
    });

    const response = await request(app)
      .get(ROUTE)
      .set("Authorization", `Bearer ${BEARER_TOKEN}`)
      .set("DPoP", proof);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("DPOP_REPLAY");
  });

  it("fails closed if a bound session reaches the middleware with no DPoP config wired", async () => {
    const { publicJwk } = await keypair();
    const { calculateJwkThumbprint } = await import("jose");
    const jkt = await calculateJwkThumbprint(publicJwk, "sha256");

    const app = buildApp({ identity: boundIdentity(jkt) });

    const response = await request(app).get(ROUTE).set("Authorization", `Bearer ${BEARER_TOKEN}`);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("DPOP_PROOF_MISSING");
  });
});

describe("require authentication: unbound session bind-on-first-sight", () => {
  it("passes an unbound session through untouched when no proof is sent", async () => {
    const app = buildApp({
      identity: unboundIdentity(new Date("2020-01-01T00:00:00.000Z")),
      dpop: { baseUrl: BASE_URL, replayRepository: buildReplayRepository() },
    });

    const response = await request(app).get(ROUTE).set("Authorization", `Bearer ${BEARER_TOKEN}`);

    expect(response.status).toBe(200);
  });

  it("binds a pre-cutover unbound session on a valid proof", async () => {
    const { privateKey, publicJwk } = await keypair();
    const { calculateJwkThumbprint } = await import("jose");
    const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
    const proof = await buildProof({ privateKey, publicJwk });
    const bindDpopKey = vi.fn().mockResolvedValue(undefined);

    const app = buildApp({
      identity: unboundIdentity(new Date("2020-01-01T00:00:00.000Z")),
      dpop: {
        baseUrl: BASE_URL,
        replayRepository: buildReplayRepository(),
        phase1CutoverAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      bindDpopKey,
    });

    const response = await request(app)
      .get(ROUTE)
      .set("Authorization", `Bearer ${BEARER_TOKEN}`)
      .set("DPoP", proof);

    expect(response.status).toBe(200);
    expect(bindDpopKey).toHaveBeenCalledWith("session_01", jkt);
  });

  it("binds when no cutover is configured at all (treats every unbound session as pre-cutover)", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk });
    const bindDpopKey = vi.fn().mockResolvedValue(undefined);

    const app = buildApp({
      identity: unboundIdentity(new Date()),
      dpop: { baseUrl: BASE_URL, replayRepository: buildReplayRepository() },
      bindDpopKey,
    });

    const response = await request(app)
      .get(ROUTE)
      .set("Authorization", `Bearer ${BEARER_TOKEN}`)
      .set("DPoP", proof);

    expect(response.status).toBe(200);
    expect(bindDpopKey).toHaveBeenCalled();
  });

  it("refuses (does not bind) a post-cutover session presenting a valid proof while unbound", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk });
    const bindDpopKey = vi.fn().mockResolvedValue(undefined);

    const app = buildApp({
      identity: unboundIdentity(new Date("2026-06-01T00:00:00.000Z")),
      dpop: {
        baseUrl: BASE_URL,
        replayRepository: buildReplayRepository(),
        phase1CutoverAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      bindDpopKey,
    });

    const response = await request(app)
      .get(ROUTE)
      .set("Authorization", `Bearer ${BEARER_TOKEN}`)
      .set("DPoP", proof);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("DPOP_KEY_MISMATCH");
    expect(bindDpopKey).not.toHaveBeenCalled();
  });

  it("does not bind on an invalid proof (best effort, no error)", async () => {
    const bindDpopKey = vi.fn().mockResolvedValue(undefined);

    const app = buildApp({
      identity: unboundIdentity(new Date("2020-01-01T00:00:00.000Z")),
      dpop: { baseUrl: BASE_URL, replayRepository: buildReplayRepository() },
      bindDpopKey,
    });

    const response = await request(app)
      .get(ROUTE)
      .set("Authorization", `Bearer ${BEARER_TOKEN}`)
      .set("DPoP", "not-a-valid-proof");

    expect(response.status).toBe(200);
    expect(bindDpopKey).not.toHaveBeenCalled();
  });

  it("does not bind on a replayed proof for an unbound session", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk });
    const bindDpopKey = vi.fn().mockResolvedValue(undefined);
    const replayRepository = buildReplayRepository({ recordProof: vi.fn().mockResolvedValue(false) });

    const app = buildApp({
      identity: unboundIdentity(new Date("2020-01-01T00:00:00.000Z")),
      dpop: { baseUrl: BASE_URL, replayRepository },
      bindDpopKey,
    });

    const response = await request(app)
      .get(ROUTE)
      .set("Authorization", `Bearer ${BEARER_TOKEN}`)
      .set("DPoP", proof);

    expect(response.status).toBe(200);
    expect(bindDpopKey).not.toHaveBeenCalled();
  });
});

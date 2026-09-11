import { randomBytes, createHash } from "node:crypto";

import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  assertDpopKeyMatchesPendingSession,
  requireDpopProofForSessionCreation,
  resolvePendingSessionDpopKey,
  tryBindDpopAtCreation,
  type BetterAuthFactoryOptions,
  type DpopCreationContext,
} from "../src/modules/auth/infrastructure/better-auth.factory.js";
import type { DpopReplayRepository } from "../src/modules/auth/repository/dpop-replay.repository.js";

const BASE_URL = "https://api.vistablox.io";
const VERIFY_PATH = `${BASE_URL}/api/auth/passkey/verify-authentication`;
const BEARER_TOKEN = "the-bearer-token";

async function keypair(): Promise<{ privateKey: CryptoKey; publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk };
}

async function buildProof(options: {
  privateKey: CryptoKey;
  publicJwk: JWK;
  jti?: string;
  omitAth?: boolean;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    htm: "POST",
    htu: VERIFY_PATH,
    iat: Math.floor(Date.now() / 1000),
    jti: options.jti ?? randomBytes(16).toString("base64url"),
  };
  if (!options.omitAth) {
    payload.ath = createHash("sha256").update(BEARER_TOKEN, "ascii").digest("base64url");
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: options.publicJwk as Record<string, unknown> })
    .sign(options.privateKey);
}

/** A real in-memory (jkt, jti) set, so double-recording actually self-collides like the real table does. */
function buildReplayRepository(): DpopReplayRepository {
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

function buildCtx(proof: string): DpopCreationContext {
  return {
    headers: new Headers({ dpop: proof, authorization: `Bearer ${BEARER_TOKEN}` }),
    request: new Request(VERIFY_PATH, { method: "POST" }),
    path: "/passkey/verify-authentication",
  };
}

describe("passkey ceremony key-match + session-creation binding, together", () => {
  it("binds the new session to the same key the ceremony already verified, recording the proof exactly once", async () => {
    const { privateKey, publicJwk } = await keypair();
    const { calculateJwkThumbprint } = await import("jose");
    const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
    const proof = await buildProof({ privateKey, publicJwk });
    const replayRepository = buildReplayRepository();
    const dpop: BetterAuthFactoryOptions["dpop"] = { baseUrl: BASE_URL, replayRepository };

    // Same request, both steps: the passkey plugin's afterVerification runs
    // assertDpopKeyMatchesPendingSession first, then internalAdapter.createSession
    // fires session.create.before -> tryBindDpopAtCreation, for the same ctx.
    const ctx = buildCtx(proof);
    await expect(assertDpopKeyMatchesPendingSession(ctx, jkt, dpop)).resolves.toBeUndefined();

    const boundJkt = await tryBindDpopAtCreation(ctx, dpop);

    expect(boundJkt).toBe(jkt);
    // The bug: this used to be called twice for the identical (jkt, jti),
    // and the second call was refused as a replay of the first.
    expect(replayRepository.recordProof).toHaveBeenCalledTimes(1);
  });

  it("still rejects a genuinely replayed proof (a different request reusing the same jti) with DPOP_REPLAY", async () => {
    const { privateKey, publicJwk } = await keypair();
    const { calculateJwkThumbprint } = await import("jose");
    const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
    const jti = randomBytes(16).toString("base64url");
    const proof = await buildProof({ privateKey, publicJwk, jti });
    const replayRepository = buildReplayRepository();
    const dpop: BetterAuthFactoryOptions["dpop"] = { baseUrl: BASE_URL, replayRepository };

    const firstRequestCtx = buildCtx(proof);
    await assertDpopKeyMatchesPendingSession(firstRequestCtx, jkt, dpop);

    // A different request (its own Request object), replaying the exact
    // same proof -- must not be treated as the single-flight same-request
    // case above, and must be rejected as an actual replay.
    const secondRequestCtx = buildCtx(proof);
    await expect(
      assertDpopKeyMatchesPendingSession(secondRequestCtx, jkt, dpop),
    ).rejects.toMatchObject({ body: { code: "DPOP_REPLAY" } });
  });

  it("logs a bind-skipped warning instead of silently swallowing an unusable proof at session creation", async () => {
    const rejected = vi.fn();
    const dpop: BetterAuthFactoryOptions["dpop"] = {
      baseUrl: BASE_URL,
      replayRepository: buildReplayRepository(),
      logger: { bound: vi.fn(), rejected },
    };
    const ctx: DpopCreationContext = {
      headers: new Headers({ dpop: "not-a-valid-proof" }),
      request: new Request(VERIFY_PATH, { method: "POST" }),
      path: "/sign-in/social",
    };

    const result = await tryBindDpopAtCreation(ctx, dpop);

    expect(result).toBeNull();
    expect(rejected).toHaveBeenCalledWith({ code: "DPOP_PROOF_INVALID", path: "/sign-in/social" });
  });
});

// Restores, for the passkey verify-* ceremony paths, the exact decision
// better-auth-dpop.plugin.ts's generic before-hook used to make for
// ordinary traffic (decideDpopForSession) before those paths started
// skipping that hook entirely (to fix the E2/L2 double-record bug above).
describe("resolvePendingSessionDpopKey", () => {
  const SESSION_CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

  it("bound + matching key: resolves, recording the proof once", async () => {
    const { privateKey, publicJwk } = await keypair();
    const { calculateJwkThumbprint } = await import("jose");
    const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
    const proof = await buildProof({ privateKey, publicJwk });
    const replayRepository = buildReplayRepository();
    const dpop: BetterAuthFactoryOptions["dpop"] = { baseUrl: BASE_URL, replayRepository };
    const ctx = buildCtx(proof);

    await expect(
      resolvePendingSessionDpopKey(ctx, jkt, SESSION_CREATED_AT, dpop),
    ).resolves.toBeUndefined();
    expect(replayRepository.recordProof).toHaveBeenCalledTimes(1);
  });

  it("bound + mismatched key: rejects with DPOP_KEY_MISMATCH", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk });
    const dpop: BetterAuthFactoryOptions["dpop"] = { baseUrl: BASE_URL, replayRepository: buildReplayRepository() };
    const ctx = buildCtx(proof);

    await expect(
      resolvePendingSessionDpopKey(ctx, "a-completely-different-jkt", SESSION_CREATED_AT, dpop),
    ).rejects.toMatchObject({ body: { code: "DPOP_KEY_MISMATCH" } });
  });

  it("unbound + no dpop header at all: passes through, nothing recorded", async () => {
    const replayRepository = buildReplayRepository();
    const dpop: BetterAuthFactoryOptions["dpop"] = { baseUrl: BASE_URL, replayRepository };
    const ctx: DpopCreationContext = {
      headers: new Headers(),
      request: new Request(VERIFY_PATH, { method: "POST" }),
      path: "/passkey/verify-authentication",
    };

    await expect(
      resolvePendingSessionDpopKey(ctx, null, SESSION_CREATED_AT, dpop),
    ).resolves.toBeUndefined();
    expect(replayRepository.recordProof).not.toHaveBeenCalled();
  });

  it("unbound + a header presented but it fails to verify: passes through (not an error -- nothing to compare it against yet)", async () => {
    const dpop: BetterAuthFactoryOptions["dpop"] = { baseUrl: BASE_URL, replayRepository: buildReplayRepository() };
    const ctx: DpopCreationContext = {
      headers: new Headers({ dpop: "not-a-valid-proof" }),
      request: new Request(VERIFY_PATH, { method: "POST" }),
      path: "/passkey/verify-authentication",
    };

    await expect(
      resolvePendingSessionDpopKey(ctx, null, SESSION_CREATED_AT, dpop),
    ).resolves.toBeUndefined();
  });

  it("unbound + a valid proof, no cutover configured: opportunistically binds (claims cached for tryBindDpopAtCreation)", async () => {
    const { privateKey, publicJwk } = await keypair();
    const { calculateJwkThumbprint } = await import("jose");
    const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
    const proof = await buildProof({ privateKey, publicJwk });
    const replayRepository = buildReplayRepository();
    const dpop: BetterAuthFactoryOptions["dpop"] = { baseUrl: BASE_URL, replayRepository };
    const ctx = buildCtx(proof);

    await expect(
      resolvePendingSessionDpopKey(ctx, null, SESSION_CREATED_AT, dpop),
    ).resolves.toBeUndefined();

    // session.create.before fires right after, for the same ctx -- it must
    // find the cached claims and bind, not re-verify-and-record.
    const boundJkt = await tryBindDpopAtCreation(ctx, dpop);
    expect(boundJkt).toBe(jkt);
    expect(replayRepository.recordProof).toHaveBeenCalledTimes(1);
  });

  it("unbound + a valid proof, session predates the cutover (pre-cutover): opportunistically binds", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk });
    const dpop: BetterAuthFactoryOptions["dpop"] = {
      baseUrl: BASE_URL,
      replayRepository: buildReplayRepository(),
      phase1CutoverAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    const ctx = buildCtx(proof);

    await expect(
      resolvePendingSessionDpopKey(ctx, null, SESSION_CREATED_AT, dpop),
    ).resolves.toBeUndefined();
  });

  it("unbound + a valid proof, session postdates the cutover: rejects with DPOP_KEY_MISMATCH -- an unbound session presenting a proof after cutover is an anomaly, not a migration case", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk });
    const dpop: BetterAuthFactoryOptions["dpop"] = {
      baseUrl: BASE_URL,
      replayRepository: buildReplayRepository(),
      phase1CutoverAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    const ctx = buildCtx(proof);
    const postCutoverSessionCreatedAt = new Date("2026-07-01T00:00:00.000Z");

    await expect(
      resolvePendingSessionDpopKey(ctx, null, postCutoverSessionCreatedAt, dpop),
    ).rejects.toMatchObject({ body: { code: "DPOP_KEY_MISMATCH" } });
  });

  it("no dpop config at all: passes through unconditionally", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk });
    const ctx = buildCtx(proof);

    await expect(
      resolvePendingSessionDpopKey(ctx, "any-jkt", SESSION_CREATED_AT, undefined),
    ).resolves.toBeUndefined();
  });
});

// Contract 3.5: L2 (login/verify) has auth "none" -- a stale Authorization
// header must never be a reason to fail, since there's no session yet for
// a bearer token to legitimately belong to.
describe("requireDpopProofForSessionCreation's ignoreAuthorizationHeader (L2)", () => {
  it("accepts a proof with no ath claim even when a stale Authorization header is present, when ignoreAuthorizationHeader is true", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk, omitAth: true });
    const dpop: BetterAuthFactoryOptions["dpop"] = { baseUrl: BASE_URL, replayRepository: buildReplayRepository() };
    const ctx: DpopCreationContext = {
      headers: new Headers({ dpop: proof, authorization: "Bearer some-stale-leftover-token" }),
      request: new Request(VERIFY_PATH, { method: "POST" }),
      path: "/device/login/verify",
    };

    await expect(
      requireDpopProofForSessionCreation(ctx, dpop, true),
    ).resolves.toMatchObject({});
  });

  it("without ignoreAuthorizationHeader (the default), the same proof is rejected against a stale Authorization header -- confirms the flag is actually doing something", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk, omitAth: true });
    const dpop: BetterAuthFactoryOptions["dpop"] = { baseUrl: BASE_URL, replayRepository: buildReplayRepository() };
    const ctx: DpopCreationContext = {
      headers: new Headers({ dpop: proof, authorization: "Bearer some-stale-leftover-token" }),
      request: new Request(VERIFY_PATH, { method: "POST" }),
      path: "/device/login/verify",
    };

    await expect(requireDpopProofForSessionCreation(ctx, dpop)).rejects.toMatchObject({
      body: { code: "DPOP_PROOF_INVALID" },
    });
  });
});

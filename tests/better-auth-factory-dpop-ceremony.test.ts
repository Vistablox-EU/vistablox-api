import { randomBytes, createHash } from "node:crypto";

import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  assertDpopKeyMatchesPendingSession,
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
}): Promise<string> {
  const payload = {
    htm: "POST",
    htu: VERIFY_PATH,
    iat: Math.floor(Date.now() / 1000),
    jti: options.jti ?? randomBytes(16).toString("base64url"),
    ath: createHash("sha256").update(BEARER_TOKEN, "ascii").digest("base64url"),
  };
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

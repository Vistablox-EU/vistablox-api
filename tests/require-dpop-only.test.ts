import { randomBytes } from "node:crypto";

import express from "express";
import request from "supertest";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { describe, expect, it, vi } from "vitest";

import { createRequireDpopOnly } from "../src/modules/auth/api/require-dpop-only.js";
import type { DpopReplayRepository } from "../src/modules/auth/repository/dpop-replay.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const BASE_URL = "https://api.vistablox.io";
const PATH = "/v1/auth/devices/enrol/challenge";

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
  return new SignJWT({
    htm: "POST",
    htu: `${BASE_URL}${PATH}`,
    iat: Math.floor(Date.now() / 1000),
    jti: options.jti ?? randomBytes(16).toString("base64url"),
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

function appFor(replayRepository: DpopReplayRepository) {
  const app = express();
  app.use(requestContext);
  const requireDpopOnly = createRequireDpopOnly({ baseUrl: BASE_URL, replayRepository });
  app.post(PATH, requireDpopOnly, (_request, response) => {
    response.json({ dpopJkt: response.locals.dpopJkt });
  });
  app.use(errorHandler);
  return app;
}

describe("createRequireDpopOnly", () => {
  it("accepts a well-formed proof and attaches its jkt to response.locals", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk });
    const app = appFor(inMemoryReplayRepository());

    const response = await request(app).post(PATH).set("dpop", proof);

    expect(response.status).toBe(200);
    expect(response.body.dpopJkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("ignores a stale Authorization header (contract 3.5: auth 'none' endpoints never fail on one)", async () => {
    const { privateKey, publicJwk } = await keypair();
    // No `ath` claim -- exactly what a real client sends here, since these
    // endpoints take no bearer token. If a leftover Authorization header
    // were still used to derive an expected ath, this proof (correctly
    // built for a bearer-token-less call) would be wrongly rejected.
    const proof = await buildProof({ privateKey, publicJwk });
    const app = appFor(inMemoryReplayRepository());

    const response = await request(app)
      .post(PATH)
      .set("dpop", proof)
      .set("authorization", "Bearer some-stale-leftover-token");

    expect(response.status).toBe(200);
  });

  it("rejects a missing proof", async () => {
    const app = appFor(inMemoryReplayRepository());
    const response = await request(app).post(PATH);
    expect(response.status).toBe(401);
  });

  it("records the proof's (jkt, jti) and rejects a second presentation of the identical proof as a replay", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk });
    const replayRepository = inMemoryReplayRepository();
    const app = appFor(replayRepository);

    const first = await request(app).post(PATH).set("dpop", proof);
    const second = await request(app).post(PATH).set("dpop", proof);

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(second.body.code).toBe("DPOP_REPLAY");
    expect(replayRepository.recordProof).toHaveBeenCalledTimes(2);
  });

  it("still accepts a genuinely fresh proof (new jti) from the same key right after", async () => {
    const { privateKey, publicJwk } = await keypair();
    const first = await buildProof({ privateKey, publicJwk });
    const second = await buildProof({ privateKey, publicJwk });
    const app = appFor(inMemoryReplayRepository());

    const firstResponse = await request(app).post(PATH).set("dpop", first);
    const secondResponse = await request(app).post(PATH).set("dpop", second);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
  });
});

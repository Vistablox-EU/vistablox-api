import { randomBytes, createHash } from "node:crypto";

import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { describe, expect, it } from "vitest";

import {
  DpopProofInvalidError,
  DpopProofMissingError,
  buildHtu,
  verifyDpopProof,
} from "../src/modules/auth/application/dpop-proof-verifier.js";

const HTM = "POST";
const HTU = "https://api.vistablox.io/v1/investor-profile/wallet";
const BEARER_TOKEN = "the-exact-bearer-token-characters";

async function keypair(): Promise<{ privateKey: CryptoKey; publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk };
}

async function buildProof(options: {
  privateKey: CryptoKey;
  publicJwk: JWK;
  htm?: string;
  htu?: string;
  iat?: number;
  jti?: string;
  ath?: string | undefined;
  alg?: string;
  typ?: string;
  omitAth?: boolean;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    htm: options.htm ?? HTM,
    htu: options.htu ?? HTU,
    iat: options.iat ?? Math.floor(Date.now() / 1000),
    jti: options.jti ?? randomBytes(16).toString("base64url"),
  };
  if (!options.omitAth) {
    payload.ath =
      options.ath ?? createHash("sha256").update(BEARER_TOKEN, "ascii").digest("base64url");
  }
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: options.alg ?? "ES256",
      typ: options.typ ?? "dpop+jwt",
      jwk: options.publicJwk as Record<string, unknown>,
    })
    .sign(options.privateKey);
}

describe("buildHtu", () => {
  it("lower-cases host, strips a default port, and keeps only the path", () => {
    expect(buildHtu("https://api.vistablox.io", "/v1/investor-profile/wallet?limit=1")).toBe(
      "https://api.vistablox.io/v1/investor-profile/wallet",
    );
  });

  it("lower-cases an explicit scheme+host too", () => {
    expect(buildHtu("https://API.Vistablox.IO", "/v1/x")).toBe("https://api.vistablox.io/v1/x");
  });

  it("keeps a non-default port", () => {
    expect(buildHtu("http://localhost:3000", "/v1/x")).toBe("http://localhost:3000/v1/x");
  });

  it("drops a default port from the base URL", () => {
    expect(buildHtu("https://api.vistablox.io:443", "/v1/x")).toBe("https://api.vistablox.io/v1/x");
  });
});

describe("verifyDpopProof", () => {
  it("accepts a well-formed proof and returns jkt/jti", async () => {
    const { privateKey, publicJwk } = await keypair();
    const jti = randomBytes(16).toString("base64url");
    const proof = await buildProof({ privateKey, publicJwk, jti });

    const result = await verifyDpopProof({
      header: proof,
      method: "post",
      url: HTU,
      bearerToken: BEARER_TOKEN,
    });

    expect(result.jti).toBe(jti);
    expect(result.jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects a missing proof", async () => {
    await expect(
      verifyDpopProof({ header: undefined, method: HTM, url: HTU, bearerToken: BEARER_TOKEN }),
    ).rejects.toBeInstanceOf(DpopProofMissingError);
    await expect(
      verifyDpopProof({ header: "  ", method: HTM, url: HTU, bearerToken: BEARER_TOKEN }),
    ).rejects.toBeInstanceOf(DpopProofMissingError);
  });

  it("rejects the wrong alg", async () => {
    // A key's own curve must match the alg it signs with (jose enforces this
    // at sign time), so exercising "wrong alg" for real means an actual
    // ES384 keypair and proof -- not an ES256 key mislabeled as ES384.
    const { privateKey, publicKey } = await generateKeyPair("ES384", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const proof = await buildProof({ privateKey, publicJwk, alg: "ES384" });
    await expect(
      verifyDpopProof({ header: proof, method: HTM, url: HTU, bearerToken: BEARER_TOKEN }),
    ).rejects.toBeInstanceOf(DpopProofInvalidError);
  });

  it("rejects the wrong typ", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk, typ: "jwt" });
    await expect(
      verifyDpopProof({ header: proof, method: HTM, url: HTU, bearerToken: BEARER_TOKEN }),
    ).rejects.toBeInstanceOf(DpopProofInvalidError);
  });

  it("rejects a jwk that carries a private key member", async () => {
    const { privateKey, publicJwk } = await keypair();
    const { privateKey: rawPrivateKey } = await generateKeyPair("ES256", { extractable: true });
    const leakedPrivateJwk = await exportJWK(rawPrivateKey);
    const proof = await new SignJWT({
      htm: HTM,
      htu: HTU,
      iat: Math.floor(Date.now() / 1000),
      jti: randomBytes(16).toString("base64url"),
      ath: createHash("sha256").update(BEARER_TOKEN, "ascii").digest("base64url"),
    })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: leakedPrivateJwk as Record<string, unknown> })
      .sign(privateKey);
    void publicJwk;

    await expect(
      verifyDpopProof({ header: proof, method: HTM, url: HTU, bearerToken: BEARER_TOKEN }),
    ).rejects.toBeInstanceOf(DpopProofInvalidError);
  });

  it("rejects a signature that doesn't match the embedded jwk", async () => {
    const signer = await keypair();
    const claimedKey = await keypair();
    // Signed by `signer`'s private key, but the embedded jwk claims to be
    // `claimedKey`'s public key -- signature verification must fail.
    const proof = await buildProof({ privateKey: signer.privateKey, publicJwk: claimedKey.publicJwk });

    await expect(
      verifyDpopProof({ header: proof, method: HTM, url: HTU, bearerToken: BEARER_TOKEN }),
    ).rejects.toBeInstanceOf(DpopProofInvalidError);
  });

  it("rejects an htm mismatch", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk, htm: "GET" });
    await expect(
      verifyDpopProof({ header: proof, method: "POST", url: HTU, bearerToken: BEARER_TOKEN }),
    ).rejects.toBeInstanceOf(DpopProofInvalidError);
  });

  it("rejects an htu mismatch (including a query string smuggled in)", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk, htu: `${HTU}?evil=1` });
    await expect(
      verifyDpopProof({ header: proof, method: HTM, url: HTU, bearerToken: BEARER_TOKEN }),
    ).rejects.toBeInstanceOf(DpopProofInvalidError);
  });

  it("rejects an iat too far in the past", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({
      privateKey,
      publicJwk,
      iat: Math.floor(Date.now() / 1000) - 120,
    });
    await expect(
      verifyDpopProof({ header: proof, method: HTM, url: HTU, bearerToken: BEARER_TOKEN }),
    ).rejects.toBeInstanceOf(DpopProofInvalidError);
  });

  it("rejects an iat too far in the future", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({
      privateKey,
      publicJwk,
      iat: Math.floor(Date.now() / 1000) + 120,
    });
    await expect(
      verifyDpopProof({ header: proof, method: HTM, url: HTU, bearerToken: BEARER_TOKEN }),
    ).rejects.toBeInstanceOf(DpopProofInvalidError);
  });

  it("rejects a missing or malformed jti", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk, jti: "short" });
    await expect(
      verifyDpopProof({ header: proof, method: HTM, url: HTU, bearerToken: BEARER_TOKEN }),
    ).rejects.toBeInstanceOf(DpopProofInvalidError);
  });

  it("rejects an ath mismatch when a bearer token is present", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk, ath: "wrong-hash" });
    await expect(
      verifyDpopProof({ header: proof, method: HTM, url: HTU, bearerToken: BEARER_TOKEN }),
    ).rejects.toBeInstanceOf(DpopProofInvalidError);
  });

  it("does not require ath when no bearer token is present (e.g. sign-in)", async () => {
    const { privateKey, publicJwk } = await keypair();
    const proof = await buildProof({ privateKey, publicJwk, omitAth: true });
    const result = await verifyDpopProof({
      header: proof,
      method: HTM,
      url: HTU,
      bearerToken: undefined,
    });
    expect(result.jkt).toBeDefined();
  });
});

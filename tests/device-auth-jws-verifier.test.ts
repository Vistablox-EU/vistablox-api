import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { describe, expect, it } from "vitest";

import {
  DeviceChallengePurposeMismatchError,
  DeviceJwsInvalidError,
  verifyDeviceAuthJws,
} from "../src/modules/auth/application/device-auth-jws-verifier.js";

const CHALLENGE = "the-exact-challenge-string";
const JWS_TYP = "vistablox-device-auth+jwt";

async function keypair(): Promise<{ privateKey: CryptoKey; publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk };
}

async function buildJws(options: {
  privateKey: CryptoKey;
  kid?: string;
  jwk?: JWK;
  alg?: string;
  typ?: string;
  purpose?: string;
  challenge?: string;
  iat?: number;
  deviceId?: string;
  omitKid?: boolean;
}): Promise<string> {
  const payload: Record<string, unknown> = {
    purpose: options.purpose ?? "enrol-device",
    challenge: options.challenge ?? CHALLENGE,
    iat: options.iat ?? Math.floor(Date.now() / 1000),
  };
  if (options.deviceId !== undefined) payload.device_id = options.deviceId;

  const header: Record<string, unknown> = {
    alg: options.alg ?? "ES256",
    typ: options.typ ?? JWS_TYP,
  };
  if (!options.omitKid) header.kid = options.kid;
  if (options.jwk !== undefined) header.jwk = options.jwk as Record<string, unknown>;

  return new SignJWT(payload)
    .setProtectedHeader(header as unknown as { alg: string })
    .sign(options.privateKey);
}

describe("verifyDeviceAuthJws", () => {
  describe("enrol-device purpose (embedded jwk)", () => {
    it("accepts a well-formed enrol-device JWS and returns claims + the embedded jwk", async () => {
      const { privateKey, publicJwk } = await keypair();
      const kid = await calculateJwkThumbprint(publicJwk, "sha256");
      const jws = await buildJws({ privateKey, kid, jwk: publicJwk, purpose: "enrol-device" });

      const claims = await verifyDeviceAuthJws({
        jws,
        expectedPurpose: "enrol-device",
        expectedChallenge: CHALLENGE,
        expectedDeviceId: undefined,
        storedPublicJwk: undefined,
      });

      expect(claims.bioJkt).toBe(kid);
      expect(claims.purpose).toBe("enrol-device");
      expect(claims.challenge).toBe(CHALLENGE);
      expect(claims.deviceId).toBeUndefined();
      expect(claims.jwk).toEqual(publicJwk);
    });

    it("rejects enrol-device with no embedded jwk", async () => {
      const { privateKey, publicJwk } = await keypair();
      const kid = await calculateJwkThumbprint(publicJwk, "sha256");
      const jws = await buildJws({ privateKey, kid, purpose: "enrol-device" });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "enrol-device",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: undefined,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });

    it("rejects an embedded jwk that carries a private key member", async () => {
      const { privateKey } = await keypair();
      const leakedPrivateJwk = await exportJWK(privateKey);
      const kid = await calculateJwkThumbprint(leakedPrivateJwk, "sha256");
      const jws = await buildJws({
        privateKey,
        kid,
        jwk: leakedPrivateJwk,
        purpose: "enrol-device",
      });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "enrol-device",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: undefined,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });
  });

  describe("non-enrol purposes (stored key)", () => {
    it("accepts a well-formed login JWS verified against the stored public jwk", async () => {
      const { privateKey, publicJwk } = await keypair();
      const kid = await calculateJwkThumbprint(publicJwk, "sha256");
      const jws = await buildJws({
        privateKey,
        kid,
        purpose: "login",
        deviceId: "device_abc",
      });

      const claims = await verifyDeviceAuthJws({
        jws,
        expectedPurpose: "login",
        expectedChallenge: CHALLENGE,
        expectedDeviceId: "device_abc",
        storedPublicJwk: publicJwk,
      });

      expect(claims.bioJkt).toBe(kid);
      expect(claims.deviceId).toBe("device_abc");
      expect(claims.jwk).toBeUndefined();
    });

    it("rejects a non-enrol JWS that embeds a jwk", async () => {
      const { privateKey, publicJwk } = await keypair();
      const kid = await calculateJwkThumbprint(publicJwk, "sha256");
      const jws = await buildJws({ privateKey, kid, jwk: publicJwk, purpose: "login" });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "login",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: publicJwk,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });

    it("rejects a non-enrol JWS with no stored key to verify against", async () => {
      const { privateKey, publicJwk } = await keypair();
      const kid = await calculateJwkThumbprint(publicJwk, "sha256");
      const jws = await buildJws({ privateKey, kid, purpose: "login" });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "login",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: undefined,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });

    it("rejects a signature that doesn't match the stored public jwk", async () => {
      const signer = await keypair();
      const claimedKey = await keypair();
      const kid = await calculateJwkThumbprint(claimedKey.publicJwk, "sha256");
      const jws = await buildJws({ privateKey: signer.privateKey, kid, purpose: "login" });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "login",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: claimedKey.publicJwk,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });
  });

  describe("header validation", () => {
    it("rejects a malformed JWS (not three parts)", async () => {
      await expect(
        verifyDeviceAuthJws({
          jws: "not-a-jws",
          expectedPurpose: "login",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: undefined,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });

    it("rejects the wrong typ", async () => {
      const { privateKey, publicJwk } = await keypair();
      const kid = await calculateJwkThumbprint(publicJwk, "sha256");
      const jws = await buildJws({ privateKey, kid, jwk: publicJwk, typ: "jwt" });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "enrol-device",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: undefined,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });

    it("rejects an unsupported alg", async () => {
      const { privateKey, publicKey } = await generateKeyPair("ES384", { extractable: true });
      const publicJwk = await exportJWK(publicKey);
      const kid = await calculateJwkThumbprint(publicJwk, "sha256");
      const jws = await buildJws({ privateKey, kid, jwk: publicJwk, alg: "ES384" });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "enrol-device",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: undefined,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });

    it("rejects a missing kid", async () => {
      const { privateKey, publicJwk } = await keypair();
      const jws = await buildJws({ privateKey, jwk: publicJwk, omitKid: true });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "enrol-device",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: undefined,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });

    it("rejects a kid that doesn't match the verification key's thumbprint", async () => {
      const { privateKey, publicJwk } = await keypair();
      const jws = await buildJws({ privateKey, kid: "not-the-real-thumbprint", jwk: publicJwk });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "enrol-device",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: undefined,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });
  });

  describe("claims validation", () => {
    it("rejects a purpose mismatch with DeviceChallengePurposeMismatchError", async () => {
      const { privateKey, publicJwk } = await keypair();
      const kid = await calculateJwkThumbprint(publicJwk, "sha256");
      const jws = await buildJws({ privateKey, kid, jwk: publicJwk, purpose: "login" });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "enrol-device",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: undefined,
        }),
      ).rejects.toBeInstanceOf(DeviceChallengePurposeMismatchError);
    });

    it("rejects a challenge mismatch", async () => {
      const { privateKey, publicJwk } = await keypair();
      const kid = await calculateJwkThumbprint(publicJwk, "sha256");
      const jws = await buildJws({
        privateKey,
        kid,
        jwk: publicJwk,
        challenge: "different-challenge",
      });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "enrol-device",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: undefined,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });

    it("rejects an iat too far in the past", async () => {
      const { privateKey, publicJwk } = await keypair();
      const kid = await calculateJwkThumbprint(publicJwk, "sha256");
      const jws = await buildJws({
        privateKey,
        kid,
        jwk: publicJwk,
        iat: Math.floor(Date.now() / 1000) - 120,
      });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "enrol-device",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: undefined,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });

    it("rejects an iat too far in the future", async () => {
      const { privateKey, publicJwk } = await keypair();
      const kid = await calculateJwkThumbprint(publicJwk, "sha256");
      const jws = await buildJws({
        privateKey,
        kid,
        jwk: publicJwk,
        iat: Math.floor(Date.now() / 1000) + 120,
      });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "enrol-device",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: undefined,
          storedPublicJwk: undefined,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });

    it("rejects a device_id mismatch when one is expected", async () => {
      const { privateKey, publicJwk } = await keypair();
      const kid = await calculateJwkThumbprint(publicJwk, "sha256");
      const jws = await buildJws({
        privateKey,
        kid,
        purpose: "login",
        deviceId: "device_wrong",
      });

      await expect(
        verifyDeviceAuthJws({
          jws,
          expectedPurpose: "login",
          expectedChallenge: CHALLENGE,
          expectedDeviceId: "device_correct",
          storedPublicJwk: publicJwk,
        }),
      ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
    });
  });
});

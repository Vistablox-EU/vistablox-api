import { webcrypto } from "node:crypto";

import { SignJWT, calculateJwkThumbprint, exportJWK, type JWK } from "jose";
import { describe, expect, it } from "vitest";

import { DeviceJwsInvalidError, verifyDeviceAuthJws } from "../src/modules/auth/application/device-auth-jws-verifier.js";

const JWS_TYP = "vistablox-device-auth+jwt";

async function deviceKey(): Promise<{ privateKey: webcrypto.CryptoKey; publicJwk: JWK; bioJkt: string }> {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = await exportJWK(pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk, bioJkt: await calculateJwkThumbprint(publicJwk, "sha256") };
}

async function loginJws(key: { privateKey: webcrypto.CryptoKey; bioJkt: string }, claims: Record<string, unknown>) {
  return new SignJWT({ purpose: "login", challenge: "c1", iat: Math.floor(Date.now() / 1000), ...claims })
    .setProtectedHeader({ alg: "ES256", typ: JWS_TYP, kid: key.bioJkt })
    .sign(key.privateKey);
}

describe("verifyDeviceAuthJws: device_id claim on login", () => {
  it("accepts a JWS without a device_id claim when the claim is optional", async () => {
    const key = await deviceKey();

    await expect(
      verifyDeviceAuthJws({
        jws: await loginJws(key, {}),
        expectedPurpose: "login",
        expectedChallenge: "c1",
        expectedDeviceId: "device_1",
        deviceIdClaimOptional: true,
        storedPublicJwk: key.publicJwk,
        expectedDpopJkt: undefined,
      }),
    ).resolves.toMatchObject({ deviceId: undefined });
  });

  it("still rejects a device_id claim for another device when the claim is optional", async () => {
    const key = await deviceKey();

    await expect(
      verifyDeviceAuthJws({
        jws: await loginJws(key, { device_id: "device_2" }),
        expectedPurpose: "login",
        expectedChallenge: "c1",
        expectedDeviceId: "device_1",
        deviceIdClaimOptional: true,
        storedPublicJwk: key.publicJwk,
        expectedDpopJkt: undefined,
      }),
    ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
  });

  it("still requires the device_id claim unless told it's optional", async () => {
    const key = await deviceKey();

    await expect(
      verifyDeviceAuthJws({
        jws: await loginJws(key, {}),
        expectedPurpose: "login",
        expectedChallenge: "c1",
        expectedDeviceId: "device_1",
        storedPublicJwk: key.publicJwk,
        expectedDpopJkt: undefined,
      }),
    ).rejects.toBeInstanceOf(DeviceJwsInvalidError);
  });
});

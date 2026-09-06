import { generateKeyPairSync } from "node:crypto";

import { decodeJwt, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";

import { createAppleClientSecret } from "../src/modules/auth/infrastructure/apple-client-secret.js";

describe("Apple OAuth client secret", () => {
  it("generates the ES256 client-secret JWT Apple requires", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const token = await createAppleClientSecret({
      clientId: "com.vistablox.web",
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: pem.replaceAll("\n", "\\n"),
      now: new Date("2026-09-06T00:00:00.000Z"),
    });

    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "ES256", kid: "KEY123" });
    expect(decodeJwt(token)).toMatchObject({
      iss: "TEAM123",
      sub: "com.vistablox.web",
      aud: "https://appleid.apple.com",
      iat: 1_788_652_800,
      exp: 1_804_204_800,
    });
  });
});

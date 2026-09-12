import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { describe, expect, it } from "vitest";

import type { StaffWebAuthnCredentialRecord } from "../src/modules/auth/repository/staff-webauthn.repository.js";
import { SimpleWebAuthnCeremony } from "../src/modules/auth/infrastructure/simple-webauthn.ceremony.js";

// The staff step-up ceremony (/internal/v1/auth/webauthn) driven by a real
// ES256 software authenticator, so the origin check runs against genuinely
// signed responses: the admin console's origin must pass once it's listed
// in WEBAUTHN_ORIGIN, and anything unlisted must still fail.
const RP_ID = "api.vistablox.io";
const API_ORIGIN = "https://api.vistablox.io";
const ADMIN_ORIGIN = "https://admin.vistablox.io";
const UNLISTED_ORIGIN = "https://evil.vistablox.io";

const ceremony = new SimpleWebAuthnCeremony({
  rpName: "VistaBlox",
  rpId: RP_ID,
  expectedOrigin: [API_ORIGIN, ADMIN_ORIGIN],
});

describe("SimpleWebAuthnCeremony origin allowlist", () => {
  it("verifies a staff passkey registration made on the admin console", async () => {
    const authenticator = createAuthenticator();
    const challenge = newChallenge();

    const result = await ceremony.verifyRegistration({
      response: authenticator.register(challenge, ADMIN_ORIGIN),
      expectedChallenge: challenge,
    });

    expect(result?.credentialId).toBe(authenticator.credentialId);
  });

  it("verifies a staff passkey authentication made on the admin console", async () => {
    const authenticator = createAuthenticator();
    const challenge = newChallenge();

    const result = await ceremony.verifyAuthentication({
      response: authenticator.authenticate(challenge, ADMIN_ORIGIN),
      expectedChallenge: challenge,
      credential: authenticator.record(),
    });

    expect(result?.newCounter).toBe(1);
  });

  it("still verifies the rpId's own origin", async () => {
    const authenticator = createAuthenticator();
    const challenge = newChallenge();

    const result = await ceremony.verifyAuthentication({
      response: authenticator.authenticate(challenge, API_ORIGIN),
      expectedChallenge: challenge,
      credential: authenticator.record(),
    });

    expect(result?.newCounter).toBe(1);
  });

  it("rejects a registration from an origin that isn't listed", async () => {
    const authenticator = createAuthenticator();
    const challenge = newChallenge();

    await expect(
      ceremony.verifyRegistration({
        response: authenticator.register(challenge, UNLISTED_ORIGIN),
        expectedChallenge: challenge,
      }),
    ).rejects.toThrow("Unexpected registration response origin");
  });

  it("rejects an authentication from an origin that isn't listed", async () => {
    const authenticator = createAuthenticator();
    const challenge = newChallenge();

    await expect(
      ceremony.verifyAuthentication({
        response: authenticator.authenticate(challenge, UNLISTED_ORIGIN),
        expectedChallenge: challenge,
        credential: authenticator.record(),
      }),
    ).rejects.toThrow("Unexpected authentication response origin");
  });

  it("rejects the admin console when only the rpId's own origin is configured", async () => {
    const singleOrigin = new SimpleWebAuthnCeremony({
      rpName: "VistaBlox",
      rpId: RP_ID,
      expectedOrigin: [API_ORIGIN],
    });
    const authenticator = createAuthenticator();
    const challenge = newChallenge();

    await expect(
      singleOrigin.verifyAuthentication({
        response: authenticator.authenticate(challenge, ADMIN_ORIGIN),
        expectedChallenge: challenge,
        credential: authenticator.record(),
      }),
    ).rejects.toThrow("Unexpected authentication response origin");
  });
});

function newChallenge(): string {
  return isoBase64URL.fromBuffer(randomBytes(32));
}

function sha256(data: Uint8Array | string): Buffer {
  return createHash("sha256").update(data).digest();
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function clientDataJSON(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;

function createAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cosePublicKey = new Uint8Array(
    isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, new Uint8Array(Buffer.from(jwk.x as string, "base64url"))],
        [-3, new Uint8Array(Buffer.from(jwk.y as string, "base64url"))],
      ]),
    ),
  );
  const rawCredentialId = randomBytes(16);
  const credentialId = isoBase64URL.fromBuffer(rawCredentialId);
  const rpIdHash = sha256(RP_ID);

  return {
    credentialId,
    record(): StaffWebAuthnCredentialRecord {
      return {
        credentialId,
        accountId: "acct_staff_01",
        publicKey: cosePublicKey,
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
        transports: ["internal"],
        label: null,
      };
    },
    register(challenge: string, origin: string): RegistrationResponseJSON {
      const credentialIdLength = Buffer.alloc(2);
      credentialIdLength.writeUInt16BE(rawCredentialId.length);
      const authenticatorData = Buffer.concat([
        rpIdHash,
        Buffer.from([FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_ATTESTED_CREDENTIAL_DATA]),
        uint32(0),
        Buffer.alloc(16), // AAGUID
        credentialIdLength,
        rawCredentialId,
        cosePublicKey,
      ]);
      const attestationObject = isoCBOR.encode(
        new Map<string, string | Map<string, string> | Uint8Array>([
          ["fmt", "none"],
          ["attStmt", new Map<string, string>()],
          ["authData", new Uint8Array(authenticatorData)],
        ]),
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON("webauthn.create", challenge, origin)),
          attestationObject: isoBase64URL.fromBuffer(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    authenticate(challenge: string, origin: string): AuthenticationResponseJSON {
      const authenticatorData = Buffer.concat([
        rpIdHash,
        Buffer.from([FLAG_USER_PRESENT | FLAG_USER_VERIFIED]),
        uint32(1),
      ]);
      const clientData = clientDataJSON("webauthn.get", challenge, origin);
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: isoBase64URL.fromBuffer(clientData),
          authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
          signature: isoBase64URL.fromBuffer(signAssertion(privateKey, authenticatorData, clientData)),
        },
        clientExtensionResults: {},
      };
    },
  };
}

// ES256 over authenticatorData || SHA-256(clientDataJSON), DER-encoded --
// what a real platform authenticator returns.
function signAssertion(
  privateKey: KeyObject,
  authenticatorData: Buffer,
  clientData: Buffer,
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    sign("sha256", Buffer.concat([authenticatorData, sha256(clientData)]), privateKey),
  );
}

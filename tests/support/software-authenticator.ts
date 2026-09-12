import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;

/**
 * A real ES256 platform authenticator in software. Its responses are
 * genuinely signed for whatever clientDataJSON origin a test asks for, so
 * the relying party's actual origin, rpId, challenge and signature checks
 * all run -- nothing about the ceremony is mocked.
 */
export function createSoftwareAuthenticator(rpId: string) {
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
  const rpIdHash = sha256(rpId);
  let signCount = 0;

  return {
    credentialId,
    /** The COSE-encoded public key, as a relying party stores it. */
    cosePublicKey,
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
      signCount += 1;
      const authenticatorData = Buffer.concat([
        rpIdHash,
        Buffer.from([FLAG_USER_PRESENT | FLAG_USER_VERIFIED]),
        uint32(signCount),
      ]);
      const clientData = clientDataJSON("webauthn.get", challenge, origin);
      // ES256 over authenticatorData || SHA-256(clientDataJSON), DER-encoded.
      const signature = new Uint8Array(
        sign("sha256", Buffer.concat([authenticatorData, sha256(clientData)]), privateKey),
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: isoBase64URL.fromBuffer(clientData),
          authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
          signature: isoBase64URL.fromBuffer(signature),
        },
        clientExtensionResults: {},
      };
    },
  };
}

export type SoftwareAuthenticator = ReturnType<typeof createSoftwareAuthenticator>;

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

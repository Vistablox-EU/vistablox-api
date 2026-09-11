import { webcrypto } from "node:crypto";

import "reflect-metadata";
import * as asn1js from "asn1js";
import { Extension, X509CertificateGenerator, cryptoProvider } from "@peculiar/x509";
import { describe, expect, it } from "vitest";

import {
  AndroidAttestationChallengeMismatchError,
  AndroidAttestationInvalidError,
  verifyAndroidKeyAttestation,
  verifyPlayIntegrityToken,
  type AndroidAttestationRevocationList,
  type PlayIntegrityVerdictDecoder,
} from "../src/modules/auth/application/android-attestation-verifier.js";
import { computeDeviceBinding } from "../src/modules/auth/domain/device-binding.js";

cryptoProvider.set(webcrypto);

const KEY_DESCRIPTION_OID = "1.3.6.1.4.1.11129.2.1.17";
const CHALLENGE = "the-attestation-challenge";
const CERT_DIGEST_HEX = "aa".repeat(32);
const AUTH_TYPE_FINGERPRINT_ONLY = 0b10;

function taggedNode(tagNumber: number, inner: object) {
  return new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber }, value: [inner as never] });
}

function buildAttestationApplicationId(certDigestHex: string): ArrayBuffer {
  const packageInfos = new asn1js.Set({ value: [] });
  const signatureDigests = new asn1js.Set({
    value: [new asn1js.OctetString({ valueHex: Buffer.from(certDigestHex, "hex") })],
  });
  return new asn1js.Sequence({ value: [packageInfos, signatureDigests] }).toBER(false);
}

function buildKeyDescription(options: {
  challenge?: string;
  userAuthType?: number | undefined;
  noAuthRequired?: boolean;
  appCertDigestHex?: string;
  securityLevel?: number;
  omitAttestationApplicationId?: boolean;
}): ArrayBuffer {
  const teeEntries: asn1js.Constructed[] = [];
  if (options.noAuthRequired) {
    teeEntries.push(taggedNode(503, new asn1js.Boolean({ value: true })));
  }
  if (options.userAuthType !== undefined) {
    teeEntries.push(taggedNode(504, new asn1js.Integer({ value: options.userAuthType })));
  }
  if (!options.omitAttestationApplicationId) {
    teeEntries.push(
      taggedNode(
        709,
        new asn1js.OctetString({
          valueHex: buildAttestationApplicationId(options.appCertDigestHex ?? CERT_DIGEST_HEX),
        }),
      ),
    );
  }
  const teeEnforced = new asn1js.Sequence({ value: teeEntries });
  const softwareEnforced = new asn1js.Sequence({ value: [] });
  const level = options.securityLevel ?? 1; // TrustedEnvironment

  return new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 300 }), // attestationVersion
      new asn1js.Enumerated({ value: level }), // attestationSecurityLevel
      new asn1js.Integer({ value: 300 }), // keymasterVersion
      new asn1js.Enumerated({ value: level }), // keymasterSecurityLevel
      new asn1js.OctetString({ valueHex: Buffer.from(options.challenge ?? CHALLENGE, "ascii") }),
      new asn1js.OctetString({ valueHex: new ArrayBuffer(0) }), // uniqueId
      softwareEnforced,
      teeEnforced,
    ],
  }).toBER(false);
}

interface ChainOptions {
  challenge?: string;
  userAuthType?: number | undefined;
  noAuthRequired?: boolean;
  appCertDigestHex?: string;
  securityLevel?: number;
  omitAttestationApplicationId?: boolean;
  omitKeyDescriptionExtension?: boolean;
  leafNotAfter?: Date;
}

async function buildChain(
  options: ChainOptions = {},
): Promise<{ rootBase64: string; leafBase64: string }> {
  const rootKeys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const rootCert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Test Root",
    notBefore: new Date("2020-01-01"),
    notAfter: new Date("2035-01-01"),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys: rootKeys,
  });

  const leafKeys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const extensions = options.omitKeyDescriptionExtension
    ? []
    : [new Extension(KEY_DESCRIPTION_OID, false, buildKeyDescription(options))];
  const leafCert = await X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=Test Leaf",
    issuer: rootCert.subject,
    notBefore: new Date("2020-01-01"),
    notAfter: options.leafNotAfter ?? new Date("2035-01-01"),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    publicKey: leafKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions,
  });

  return {
    rootBase64: Buffer.from(rootCert.rawData).toString("base64"),
    leafBase64: Buffer.from(leafCert.rawData).toString("base64"),
  };
}

const notRevoked: AndroidAttestationRevocationList = { isRevoked: async () => false };
const allRevoked: AndroidAttestationRevocationList = { isRevoked: async () => true };

async function verify(
  chain: { rootBase64: string; leafBase64: string },
  overrides: Partial<{
    certDigestAllowlist: string[];
    challenge: string;
    pinnedRootCertificates: string[];
    revocationList: AndroidAttestationRevocationList;
    certificateChain: string[];
  }> = {},
): Promise<void> {
  await verifyAndroidKeyAttestation({
    certificateChain: overrides.certificateChain ?? [chain.leafBase64, chain.rootBase64],
    pinnedRootCertificates: overrides.pinnedRootCertificates ?? [chain.rootBase64],
    certDigestAllowlist: overrides.certDigestAllowlist ?? [CERT_DIGEST_HEX],
    challenge: overrides.challenge ?? CHALLENGE,
    bioJkt: "whatever-bio-jkt",
    revocationList: overrides.revocationList ?? notRevoked,
  });
}

describe("verifyAndroidKeyAttestation", () => {
  it("accepts a well-formed chain: hardware-backed, biometric-only, on the cert-digest allowlist", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY });
    await expect(verify(chain)).resolves.toBeUndefined();
  });

  it("rejects an empty certificate chain", async () => {
    await expect(
      verifyAndroidKeyAttestation({
        certificateChain: [],
        pinnedRootCertificates: ["irrelevant"],
        certDigestAllowlist: [CERT_DIGEST_HEX],
        challenge: CHALLENGE,
        bioJkt: "x",
        revocationList: notRevoked,
      }),
    ).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects when no pinned root certificates are configured", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY });
    await expect(verify(chain, { pinnedRootCertificates: [] })).rejects.toBeInstanceOf(
      AndroidAttestationInvalidError,
    );
  });

  it("rejects a chain that does not terminate at a pinned root", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY });
    const otherChain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY });
    await expect(
      verify(chain, { pinnedRootCertificates: [otherChain.rootBase64] }),
    ).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a malformed certificate", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY });
    await expect(
      verify(chain, { certificateChain: ["not-valid-base64-der", chain.rootBase64] }),
    ).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects an expired certificate", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      leafNotAfter: new Date("2021-01-01"),
    });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a revoked certificate", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY });
    await expect(verify(chain, { revocationList: allRevoked })).rejects.toBeInstanceOf(
      AndroidAttestationInvalidError,
    );
  });

  it("rejects a missing key-attestation extension", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      omitKeyDescriptionExtension: true,
    });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a software-backed key (not hardware-attested)", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, securityLevel: 0 });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects with AndroidAttestationChallengeMismatchError when the attested challenge doesn't match", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      challenge: "a-different-challenge",
    });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationChallengeMismatchError);
  });

  it("rejects a key with noAuthRequired set", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, noAuthRequired: true });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a key with no user-authentication requirement attested at all", async () => {
    const chain = await buildChain({ userAuthType: undefined });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a key that accepts device-credential (password) fallback", async () => {
    const chain = await buildChain({ userAuthType: 0b01 | 0b10 });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a key that does not require biometric authentication", async () => {
    const chain = await buildChain({ userAuthType: 0 });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects when no attestationApplicationId is present", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      omitAttestationApplicationId: true,
    });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects an app-signing certificate that isn't on the digest allowlist", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      appCertDigestHex: "bb".repeat(32),
    });
    await expect(verify(chain, { certDigestAllowlist: [CERT_DIGEST_HEX] })).rejects.toBeInstanceOf(
      AndroidAttestationInvalidError,
    );
  });

  it("accepts an allowlist digest formatted with colons and uppercase, as openssl/keytool print it", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY });
    const colonSeparatedUppercase = CERT_DIGEST_HEX.toUpperCase().replace(/(.{2})(?=.)/g, "$1:");
    await expect(
      verify(chain, { certDigestAllowlist: [colonSeparatedUppercase] }),
    ).resolves.toBeUndefined();
  });
});

describe("verifyPlayIntegrityToken", () => {
  const neverCalledDecoder: PlayIntegrityVerdictDecoder = {
    decode: async () => {
      throw new Error("decoder should not be called when policy is disabled");
    },
  };

  function decoderReturning(verdict: {
    requestHash?: string;
    appRecognitionVerdict?: string;
    deviceRecognitionVerdicts?: string[];
    certificateSha256Digests?: string[];
  }): PlayIntegrityVerdictDecoder {
    return {
      decode: async () => ({
        requestHash: verdict.requestHash,
        appRecognitionVerdict: verdict.appRecognitionVerdict ?? "PLAY_RECOGNIZED",
        deviceRecognitionVerdicts: verdict.deviceRecognitionVerdicts ?? ["MEETS_DEVICE_INTEGRITY"],
        certificateSha256Digests: verdict.certificateSha256Digests ?? [CERT_DIGEST_HEX],
      }),
    };
  }

  it("skips verification entirely when policy is disabled", async () => {
    await expect(
      verifyPlayIntegrityToken({
        policy: "disabled",
        token: undefined,
        challenge: CHALLENGE,
        bioJkt: "bio",
        certDigestAllowlist: [CERT_DIGEST_HEX],
        decoder: neverCalledDecoder,
      }),
    ).resolves.toBeUndefined();
  });

  it("requires a token when policy is not disabled", async () => {
    await expect(
      verifyPlayIntegrityToken({
        policy: "relaxed",
        token: undefined,
        challenge: CHALLENGE,
        bioJkt: "bio",
        certDigestAllowlist: [CERT_DIGEST_HEX],
        decoder: neverCalledDecoder,
      }),
    ).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("accepts a well-formed strict-policy verdict with the correct requestHash", async () => {
    const requestHash = computeDeviceBinding(CHALLENGE, "bio");
    await expect(
      verifyPlayIntegrityToken({
        policy: "strict",
        token: "token",
        challenge: CHALLENGE,
        bioJkt: "bio",
        certDigestAllowlist: [CERT_DIGEST_HEX],
        decoder: decoderReturning({ requestHash }),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a requestHash that doesn't match the binding", async () => {
    await expect(
      verifyPlayIntegrityToken({
        policy: "strict",
        token: "token",
        challenge: CHALLENGE,
        bioJkt: "bio",
        certDigestAllowlist: [CERT_DIGEST_HEX],
        decoder: decoderReturning({ requestHash: "wrong-hash" }),
      }),
    ).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("strict policy rejects UNRECOGNIZED_VERSION (sideloaded)", async () => {
    const requestHash = computeDeviceBinding(CHALLENGE, "bio");
    await expect(
      verifyPlayIntegrityToken({
        policy: "strict",
        token: "token",
        challenge: CHALLENGE,
        bioJkt: "bio",
        certDigestAllowlist: [CERT_DIGEST_HEX],
        decoder: decoderReturning({ requestHash, appRecognitionVerdict: "UNRECOGNIZED_VERSION" }),
      }),
    ).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("relaxed policy accepts UNRECOGNIZED_VERSION (sideloaded)", async () => {
    const requestHash = computeDeviceBinding(CHALLENGE, "bio");
    await expect(
      verifyPlayIntegrityToken({
        policy: "relaxed",
        token: "token",
        challenge: CHALLENGE,
        bioJkt: "bio",
        certDigestAllowlist: [CERT_DIGEST_HEX],
        decoder: decoderReturning({ requestHash, appRecognitionVerdict: "UNRECOGNIZED_VERSION" }),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a weak device-recognition verdict", async () => {
    const requestHash = computeDeviceBinding(CHALLENGE, "bio");
    await expect(
      verifyPlayIntegrityToken({
        policy: "relaxed",
        token: "token",
        challenge: CHALLENGE,
        bioJkt: "bio",
        certDigestAllowlist: [CERT_DIGEST_HEX],
        decoder: decoderReturning({ requestHash, deviceRecognitionVerdicts: [] }),
      }),
    ).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a certificate digest not on the allowlist", async () => {
    const requestHash = computeDeviceBinding(CHALLENGE, "bio");
    await expect(
      verifyPlayIntegrityToken({
        policy: "relaxed",
        token: "token",
        challenge: CHALLENGE,
        bioJkt: "bio",
        certDigestAllowlist: [CERT_DIGEST_HEX],
        decoder: decoderReturning({ requestHash, certificateSha256Digests: ["bb".repeat(32)] }),
      }),
    ).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("accepts an allowlist digest formatted with colons and uppercase", async () => {
    const requestHash = computeDeviceBinding(CHALLENGE, "bio");
    const colonSeparatedUppercase = CERT_DIGEST_HEX.toUpperCase().replace(/(.{2})(?=.)/g, "$1:");
    await expect(
      verifyPlayIntegrityToken({
        policy: "relaxed",
        token: "token",
        challenge: CHALLENGE,
        bioJkt: "bio",
        certDigestAllowlist: [colonSeparatedUppercase],
        decoder: decoderReturning({ requestHash }),
      }),
    ).resolves.toBeUndefined();
  });
});

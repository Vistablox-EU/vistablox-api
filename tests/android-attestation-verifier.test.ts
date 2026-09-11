import { webcrypto } from "node:crypto";

import "reflect-metadata";
import * as asn1js from "asn1js";
import {
  BasicConstraintsExtension,
  Extension,
  KeyUsageFlags,
  KeyUsagesExtension,
  X509CertificateGenerator,
  cryptoProvider,
} from "@peculiar/x509";
import { calculateJwkThumbprint, exportJWK } from "jose";
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
const PACKAGE_NAME = "com.vistablox.app";
const AUTH_TYPE_FINGERPRINT_ONLY = 0b10;
const KM_PURPOSE_SIGN = 2;
const KM_ALGORITHM_EC = 3;
const KM_EC_CURVE_P256 = 1;
const KM_DIGEST_SHA_2_256 = 4;
const KM_ORIGIN_GENERATED = 0;
const VERIFIED_BOOT_STATE_VERIFIED = 0;
const VERIFIED_BOOT_STATE_UNVERIFIED = 2;

function taggedNode(tagNumber: number, inner: object) {
  return new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber }, value: [inner as never] });
}

function buildAttestationApplicationId(packageName: string, certDigestHex: string): ArrayBuffer {
  const packageInfo = new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: Buffer.from(packageName, "utf8") }),
      new asn1js.Integer({ value: 1 }),
    ],
  });
  const packageInfos = new asn1js.Set({ value: [packageInfo] });
  const signatureDigests = new asn1js.Set({
    value: [new asn1js.OctetString({ valueHex: Buffer.from(certDigestHex, "hex") })],
  });
  return new asn1js.Sequence({ value: [packageInfos, signatureDigests] }).toBER(false);
}

// rootOfTrust is [704] EXPLICIT RootOfTrust -- the tag wraps the SEQUENCE
// directly (unlike attestationApplicationId, which is [709] EXPLICIT OCTET
// STRING wrapping a separately-DER-encoded structure).
function buildRootOfTrust(deviceLocked: boolean, verifiedBootState: number): asn1js.Sequence {
  return new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: new ArrayBuffer(32) }),
      new asn1js.Boolean({ value: deviceLocked }),
      new asn1js.Enumerated({ value: verifiedBootState }),
      new asn1js.OctetString({ valueHex: new ArrayBuffer(32) }),
    ],
  });
}

interface KeyDescriptionOptions {
  challenge?: string;
  attestationVersion?: number;
  keymasterVersion?: number;
  securityLevel?: number;
  userAuthType?: number | undefined;
  noAuthRequired?: boolean;
  authTimeout?: number;
  allowWhileOnBody?: boolean;
  unlockedDeviceRequired?: boolean;
  origin?: number;
  purpose?: number[];
  algorithm?: number;
  ecCurve?: number;
  digest?: number[];
  deviceLocked?: boolean;
  verifiedBootState?: number;
  omitRootOfTrust?: boolean;
  packageName?: string;
  appCertDigestHex?: string;
  omitAttestationApplicationId?: boolean;
}

function buildKeyDescription(options: KeyDescriptionOptions = {}): ArrayBuffer {
  const teeEntries: asn1js.Constructed[] = [];
  teeEntries.push(
    taggedNode(1, new asn1js.Set({ value: (options.purpose ?? [KM_PURPOSE_SIGN]).map((p) => new asn1js.Integer({ value: p })) })),
  );
  teeEntries.push(taggedNode(2, new asn1js.Integer({ value: options.algorithm ?? KM_ALGORITHM_EC })));
  teeEntries.push(
    taggedNode(5, new asn1js.Set({ value: (options.digest ?? [KM_DIGEST_SHA_2_256]).map((d) => new asn1js.Integer({ value: d })) })),
  );
  teeEntries.push(taggedNode(10, new asn1js.Integer({ value: options.ecCurve ?? KM_EC_CURVE_P256 })));
  if (options.noAuthRequired) {
    teeEntries.push(taggedNode(503, new asn1js.Boolean({ value: true })));
  }
  if (options.userAuthType !== undefined) {
    teeEntries.push(taggedNode(504, new asn1js.Integer({ value: options.userAuthType })));
  }
  if (options.authTimeout !== undefined) {
    teeEntries.push(taggedNode(505, new asn1js.Integer({ value: options.authTimeout })));
  }
  if (options.allowWhileOnBody === true) {
    teeEntries.push(taggedNode(506, new asn1js.Boolean({ value: true })));
  }
  if (options.unlockedDeviceRequired !== false) {
    teeEntries.push(taggedNode(509, new asn1js.Boolean({ value: true })));
  }
  teeEntries.push(taggedNode(702, new asn1js.Integer({ value: options.origin ?? KM_ORIGIN_GENERATED })));
  if (!options.omitRootOfTrust) {
    teeEntries.push(
      taggedNode(
        704,
        buildRootOfTrust(options.deviceLocked ?? true, options.verifiedBootState ?? VERIFIED_BOOT_STATE_VERIFIED),
      ),
    );
  }
  if (!options.omitAttestationApplicationId) {
    teeEntries.push(
      taggedNode(
        709,
        new asn1js.OctetString({
          valueHex: buildAttestationApplicationId(
            options.packageName ?? PACKAGE_NAME,
            options.appCertDigestHex ?? CERT_DIGEST_HEX,
          ),
        }),
      ),
    );
  }
  const teeEnforced = new asn1js.Sequence({ value: teeEntries });
  const softwareEnforced = new asn1js.Sequence({ value: [] });
  const level = options.securityLevel ?? 1; // TrustedEnvironment

  return new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: options.attestationVersion ?? 300 }),
      new asn1js.Enumerated({ value: level }),
      new asn1js.Integer({ value: options.keymasterVersion ?? 300 }),
      new asn1js.Enumerated({ value: level }),
      new asn1js.OctetString({ valueHex: Buffer.from(options.challenge ?? CHALLENGE, "ascii") }),
      new asn1js.OctetString({ valueHex: new ArrayBuffer(0) }),
      softwareEnforced,
      teeEnforced,
    ],
  }).toBER(false);
}

interface ChainOptions extends KeyDescriptionOptions {
  omitKeyDescriptionExtension?: boolean;
  leafNotAfter?: Date;
  rootHasCaConstraint?: boolean;
  rootHasKeyCertSign?: boolean;
  /** Deliberately claims a different issuer name than the signing root's real subject. */
  leafIssuerOverride?: string;
  /** Sign the leaf with a different, unrelated key than the one the leaf's SPKI/attestation describes. */
  signWithUnrelatedKey?: boolean;
}

async function buildChain(
  options: ChainOptions = {},
): Promise<{ rootBase64: string; leafBase64: string; bioJkt: string }> {
  const rootKeys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const rootExtensions =
    options.rootHasCaConstraint === false
      ? []
      : [
          new BasicConstraintsExtension(true, undefined, true),
          ...(options.rootHasKeyCertSign === false
            ? []
            : [new KeyUsagesExtension(KeyUsageFlags.keyCertSign, true)]),
        ];
  const rootCert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Test Root",
    notBefore: new Date("2020-01-01"),
    notAfter: new Date("2035-01-01"),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys: rootKeys,
    extensions: rootExtensions,
  });

  const leafKeys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const signingKeyPair = options.signWithUnrelatedKey
    ? await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
    : rootKeys;
  const extensions = options.omitKeyDescriptionExtension
    ? []
    : [new Extension(KEY_DESCRIPTION_OID, false, buildKeyDescription(options))];
  const leafCert = await X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=Test Leaf",
    issuer: options.leafIssuerOverride ?? rootCert.subject,
    notBefore: new Date("2020-01-01"),
    notAfter: options.leafNotAfter ?? new Date("2035-01-01"),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    publicKey: leafKeys.publicKey,
    signingKey: signingKeyPair.privateKey,
    extensions,
  });

  const publicJwk = await exportJWK(leafKeys.publicKey);
  const bioJkt = await calculateJwkThumbprint(publicJwk, "sha256");

  return {
    rootBase64: Buffer.from(rootCert.rawData).toString("base64"),
    leafBase64: Buffer.from(leafCert.rawData).toString("base64"),
    bioJkt,
  };
}

const notRevoked: AndroidAttestationRevocationList = { isRevoked: async () => false };
const allRevoked: AndroidAttestationRevocationList = { isRevoked: async () => true };

async function verify(
  chain: { rootBase64: string; leafBase64: string; bioJkt: string },
  overrides: Partial<{
    certDigestAllowlist: string[];
    challenge: string;
    pinnedRootCertificates: string[];
    revocationList: AndroidAttestationRevocationList;
    certificateChain: string[];
    bioJkt: string;
  }> = {},
): Promise<void> {
  await verifyAndroidKeyAttestation({
    certificateChain: overrides.certificateChain ?? [chain.leafBase64, chain.rootBase64],
    pinnedRootCertificates: overrides.pinnedRootCertificates ?? [chain.rootBase64],
    certDigestAllowlist: overrides.certDigestAllowlist ?? [CERT_DIGEST_HEX],
    challenge: overrides.challenge ?? CHALLENGE,
    bioJkt: overrides.bioJkt ?? chain.bioJkt,
    revocationList: overrides.revocationList ?? notRevoked,
  });
}

describe("verifyAndroidKeyAttestation: well-formed chain", () => {
  it("accepts a well-formed chain: CA-rooted, hardware-backed, biometric-only, per-use, locked+verified boot, on the cert-digest and package allowlist", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY });
    await expect(verify(chain)).resolves.toBeUndefined();
  });
});

describe("verifyAndroidKeyAttestation: structural/chain checks", () => {
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

  it("passes the revocation list a serial normalized like Google's own list (BigInteger.toString(16), no leading zero nibble)", async () => {
    // A serial of 0x0abc must be looked up as "abc", not "0abc" -- @peculiar/x509's
    // own serialNumber getter keeps the leading zero nibble, which would never match
    // Google's list-key format otherwise.
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const cert = await X509CertificateGenerator.createSelfSigned({
      serialNumber: "0abc",
      name: "CN=x",
      notBefore: new Date("2020-01-01"),
      notAfter: new Date("2035-01-01"),
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      keys,
      extensions: [new BasicConstraintsExtension(true, undefined, true)],
    });
    const seen: string[] = [];
    const base64 = Buffer.from(cert.rawData).toString("base64");
    await verifyAndroidKeyAttestation({
      certificateChain: [base64],
      pinnedRootCertificates: [base64],
      certDigestAllowlist: [CERT_DIGEST_HEX],
      challenge: "c",
      bioJkt: "b",
      revocationList: {
        isRevoked: async (serial) => {
          seen.push(serial);
          return false;
        },
      },
    }).catch(() => undefined);
    expect(seen[0]).toBe("abc");
  });

  it("rejects a missing key-attestation extension", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      omitKeyDescriptionExtension: true,
    });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });
});

describe("verifyAndroidKeyAttestation: forged-leaf / CA-authorization checks (CRITICAL)", () => {
  it("rejects a leaf signed by an ordinary attested key that is not itself a CA (no basicConstraints cA=true)", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      rootHasCaConstraint: false,
    });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects an issuer marked cA=true but missing the keyCertSign key usage", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      rootHasKeyCertSign: false,
    });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects when the leaf's issuer name does not match the signing certificate's actual subject", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      leafIssuerOverride: "CN=Someone Else Entirely",
    });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("full forged-leaf PoC: an attacker's own genuinely-attested (non-CA) key cannot be used to sign an arbitrary forged leaf", async () => {
    // A genuine attested key A (real chain to a pinned root, TEE, any
    // challenge, attacker's own app) -- an ordinary end-entity leaf, not a CA.
    const rootKeys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const root = await X509CertificateGenerator.createSelfSigned({
      serialNumber: "01",
      name: "CN=Pinned Root",
      notBefore: new Date("2020-01-01"),
      notAfter: new Date("2035-01-01"),
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      keys: rootKeys,
      extensions: [new BasicConstraintsExtension(true, undefined, true)],
    });
    const keyA = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const certA = await X509CertificateGenerator.create({
      serialNumber: "02",
      subject: "CN=Android Keystore Key",
      issuer: root.subject,
      notBefore: new Date("2020-01-01"),
      notAfter: new Date("2035-01-01"),
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      publicKey: keyA.publicKey,
      signingKey: rootKeys.privateKey,
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new Extension(KEY_DESCRIPTION_OID, false, buildKeyDescription({ challenge: "unrelated" })),
      ],
    });

    // The attacker uses key A's own Keystore sign() to forge a "leaf" over
    // an arbitrary (software) key, carrying whatever KeyDescription they like.
    const softwareKey = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const publicJwk = await exportJWK(softwareKey.publicKey);
    const forgedBioJkt = await calculateJwkThumbprint(publicJwk, "sha256");
    const forged = await X509CertificateGenerator.create({
      serialNumber: "03",
      subject: "CN=Forged",
      issuer: certA.subject,
      notBefore: new Date("2020-01-01"),
      notAfter: new Date("2035-01-01"),
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      publicKey: softwareKey.publicKey,
      signingKey: keyA.privateKey,
      extensions: [
        new Extension(
          KEY_DESCRIPTION_OID,
          false,
          buildKeyDescription({ challenge: "SERVER-CHALLENGE", userAuthType: AUTH_TYPE_FINGERPRINT_ONLY }),
        ),
      ],
    });

    const b64 = (c: { rawData: ArrayBuffer }) => Buffer.from(c.rawData).toString("base64");
    await expect(
      verifyAndroidKeyAttestation({
        certificateChain: [b64(forged), b64(certA), b64(root)],
        pinnedRootCertificates: [b64(root)],
        certDigestAllowlist: [CERT_DIGEST_HEX],
        challenge: "SERVER-CHALLENGE",
        bioJkt: forgedBioJkt,
        revocationList: notRevoked,
      }),
    ).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });
});

describe("verifyAndroidKeyAttestation: attested-key binding (CRITICAL)", () => {
  it("rejects when the attested key does not match the caller's expected bioJkt", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY });
    await expect(
      verify(chain, { bioJkt: "completely-unrelated-bio-jkt" }),
    ).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });
});

describe("verifyAndroidKeyAttestation: hardware/security level", () => {
  it("rejects a software-backed key (not hardware-attested)", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, securityLevel: 0 });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects an unrecognized security level value", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, securityLevel: 5 });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects with AndroidAttestationChallengeMismatchError when the attested challenge doesn't match", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      challenge: "a-different-challenge",
    });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationChallengeMismatchError);
  });
});

describe("verifyAndroidKeyAttestation: attestation version floor", () => {
  it("rejects an attestationVersion below the minimum (2 = Android 8)", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, attestationVersion: 2 });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("accepts attestationVersion 3 (Android 9, the minimum)", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      attestationVersion: 3,
      keymasterVersion: 3,
    });
    await expect(verify(chain)).resolves.toBeUndefined();
  });

  it("accepts a KeyMint-numbered version (300)", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      attestationVersion: 300,
      keymasterVersion: 300,
    });
    await expect(verify(chain)).resolves.toBeUndefined();
  });

  it("rejects when keymasterVersion is below the minimum even if attestationVersion passes", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      attestationVersion: 300,
      keymasterVersion: 2,
    });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });
});

describe("verifyAndroidKeyAttestation: authentication requirements", () => {
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

  it("rejects a key with a nonzero authTimeout (time-bound validity, not per-use)", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, authTimeout: 300 });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("accepts an explicit authTimeout of 0 (per-use)", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, authTimeout: 0 });
    await expect(verify(chain)).resolves.toBeUndefined();
  });

  it("rejects a key usable without authentication while on-body", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, allowWhileOnBody: true });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a key that does not require the device to be unlocked", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, unlockedDeviceRequired: false });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });
});

describe("verifyAndroidKeyAttestation: key origin/shape", () => {
  it("rejects an imported key (origin != GENERATED)", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, origin: 2 });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a key whose purpose is not SIGN-only", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, purpose: [1] });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a key whose purpose includes SIGN plus something else", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, purpose: [KM_PURPOSE_SIGN, 1] });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a non-EC algorithm", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, algorithm: 1 });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a non-P-256 curve", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, ecCurve: 2 });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a key that does not attest SHA-256 as an allowed digest", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, digest: [2] });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });
});

describe("verifyAndroidKeyAttestation: root of trust", () => {
  it("rejects when no hardware-enforced root of trust is attested", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, omitRootOfTrust: true });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects an unlocked bootloader (deviceLocked=false)", async () => {
    const chain = await buildChain({ userAuthType: AUTH_TYPE_FINGERPRINT_ONLY, deviceLocked: false });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("rejects a verified boot state that isn't Verified", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      verifiedBootState: VERIFIED_BOOT_STATE_UNVERIFIED,
    });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
  });

  it("accepts an explicitly Verified boot state", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      verifiedBootState: VERIFIED_BOOT_STATE_VERIFIED,
    });
    await expect(verify(chain)).resolves.toBeUndefined();
  });
});

describe("verifyAndroidKeyAttestation: app identity", () => {
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

  it("rejects an attested package name that isn't com.vistablox.app", async () => {
    const chain = await buildChain({
      userAuthType: AUTH_TYPE_FINGERPRINT_ONLY,
      packageName: "com.attacker.evil",
    });
    await expect(verify(chain)).rejects.toBeInstanceOf(AndroidAttestationInvalidError);
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

  it("rejects a decode failure instead of throwing an unhandled/500-shaped error", async () => {
    await expect(
      verifyPlayIntegrityToken({
        policy: "relaxed",
        token: "token",
        challenge: CHALLENGE,
        bioJkt: "bio",
        certDigestAllowlist: [CERT_DIGEST_HEX],
        decoder: { decode: async () => { throw new Error("boom"); } },
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

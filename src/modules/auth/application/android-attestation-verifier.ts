import { webcrypto } from "node:crypto";

// @peculiar/x509 uses tsyringe internally, which throws at import time if
// this polyfill hasn't been loaded first -- must be the first import here,
// before anything else in this file touches @peculiar/x509.
import "reflect-metadata";

import * as asn1js from "asn1js";
import {
  BasicConstraintsExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  cryptoProvider,
  X509Certificate,
} from "@peculiar/x509";
import { calculateJwkThumbprint, type JWK } from "jose";

import { computeDeviceBinding } from "../domain/device-binding.js";

// @peculiar/x509 expects the DOM Crypto interface type, which this
// codebase's tsconfig doesn't pull in (lib: ["ES2023"], no "DOM") --
// node:crypto's webcrypto is runtime-compatible (both implement the
// WebCrypto standard), the mismatch is purely in the ambient type name, so
// this cast goes through `never` rather than trying to name a type that
// isn't in scope.
cryptoProvider.set(webcrypto as unknown as never);

// Android Key Attestation extension OID (source.android.com/docs/security/
// features/keystore/attestation). Present on every hardware-attested key.
const KEY_DESCRIPTION_OID = "1.3.6.1.4.1.11129.2.1.17";

// KeyDescription's attestationVersion/keymasterVersion (or keyMintVersion,
// same field position, KeyMint just numbers its own scheme differently --
// see source.android.com's version table): 1 = Android 7 (Keymaster 2),
// 2 = Android 8 (Keymaster 3), 3 = Android 9 (Keymaster 4), 4 = Keymaster
// 4.1, and KeyMint reports 100/200/300/400... (always >= 100). A plain
// numeric >= comparison handles all of these uniformly -- an allowlist of
// exact values would silently reject every future KeyMint release. Below
// this, tags this verifier now requires (RootOfTrust, unlockedDeviceRequired)
// either don't exist yet in the schema or aren't reliably populated, so
// raising this floor is the only way to make them meaningful. Damir's call
// (2026-09-11): the app's minSdk is 28 (Android 9+), so every real device
// this ever runs against attests version >= 3 -- there is no legitimate
// case this floor needs to accommodate below it.
const MINIMUM_ATTESTATION_VERSION = 3;

// AuthorizationList tag numbers (KeyMint/Keymaster HAL). Schema at
// source.android.com/docs/security/features/keystore/attestation.
const TAG_PURPOSE = 1;
const TAG_ALGORITHM = 2;
const TAG_DIGEST = 5;
const TAG_EC_CURVE = 10;
const TAG_NO_AUTH_REQUIRED = 503;
const TAG_USER_AUTH_TYPE = 504;
const TAG_AUTH_TIMEOUT = 505;
const TAG_ALLOW_WHILE_ON_BODY = 506;
const TAG_UNLOCKED_DEVICE_REQUIRED = 509;
const TAG_ORIGIN = 702;
const TAG_ROOT_OF_TRUST = 704;
const TAG_ATTESTATION_APPLICATION_ID = 709;

// HardwareAuthenticatorType bitmask (Keymaster HAL). AUTH_BIOMETRIC_STRONG
// enrolment attests as FINGERPRINT only; PASSWORD is the device-credential
// bit, which "biometrics mandatory, no fallback" must never see set.
const AUTH_TYPE_PASSWORD_BIT = 0b01;
const AUTH_TYPE_FINGERPRINT_BIT = 0b10;

// attestationSecurityLevel / keymasterSecurityLevel ENUMERATED values.
// Explicit membership, not just "!= SOFTWARE": a future or malformed value
// this verifier doesn't recognize must be refused, not waved through.
const SECURITY_LEVEL_TRUSTED_ENVIRONMENT = 1;
const SECURITY_LEVEL_STRONGBOX = 2;
const HARDWARE_SECURITY_LEVELS = new Set([SECURITY_LEVEL_TRUSTED_ENVIRONMENT, SECURITY_LEVEL_STRONGBOX]);

// KM_PURPOSE / KM_ALGORITHM / KM_EC_CURVE / KM_DIGEST / KM_ORIGIN enum
// values this verifier requires -- #19's key spec generates a SIGN-only,
// EC/P-256, hardware-generated (never imported) key.
const KM_PURPOSE_SIGN = 2;
const KM_ALGORITHM_EC = 3;
const KM_EC_CURVE_P256 = 1;
const KM_DIGEST_SHA_2_256 = 4;
const KM_ORIGIN_GENERATED = 0;
const VERIFIED_BOOT_STATE_VERIFIED = 0;

export class AndroidAttestationInvalidError extends Error {
  public readonly code = "ATTESTATION_INVALID" as const;
  public constructor(reason: string) {
    super(`Android key attestation rejected: ${reason}`);
    this.name = "AndroidAttestationInvalidError";
  }
}

export class AndroidAttestationChallengeMismatchError extends Error {
  public readonly code = "ATTESTATION_CHALLENGE_MISMATCH" as const;
  public constructor() {
    super("The attested challenge does not match the binding this request expects.");
    this.name = "AndroidAttestationChallengeMismatchError";
  }
}

export type AndroidAttestationError =
  | AndroidAttestationInvalidError
  | AndroidAttestationChallengeMismatchError;

export function isAndroidAttestationError(error: unknown): error is AndroidAttestationError {
  return (
    error instanceof AndroidAttestationInvalidError ||
    error instanceof AndroidAttestationChallengeMismatchError
  );
}

/**
 * Checks (and caches) the Android hardware-attestation revocation list.
 * Injected so the verifier itself stays free of network I/O and is
 * trivially unit-testable; the real implementation
 * (HttpAndroidAttestationRevocationList) fetches
 * https://android.googleapis.com/attestation/status, caches for <=24h, and
 * fails closed (treats every cert as revoked) once the cache is stale
 * beyond 72h. `certificateSerialHex` is already normalized the way Google's
 * list itself formats serials (see normalizeSerialHex below) -- the
 * implementation should look it up as-is, not reformat it again.
 */
export interface AndroidAttestationRevocationList {
  isRevoked(certificateSerialHex: string): Promise<boolean>;
}

export interface AndroidKeyAttestationInput {
  /** Base64 DER, leaf first. */
  certificateChain: string[];
  /** Base64 DER of the pinned Google hardware-attestation roots. */
  pinnedRootCertificates: string[];
  /** SHA-256 digests (hex) of the acceptable app-signing certificates. */
  certDigestAllowlist: string[];
  challenge: string;
  /** The enrolling/authenticating device's own key thumbprint (RFC 7638) -- the attested key must be this exact key, not merely *a* validly-attested one. */
  bioJkt: string;
  revocationList: AndroidAttestationRevocationList;
  now?: Date;
}

/**
 * Verifies an Android key-attestation certificate chain against the wire
 * contract: chain-of-trust to a pinned root (including that every issuer is
 * actually a CA authorized to sign certificates, not merely a validly
 * attested ordinary key -- see verifyChainOfTrust's own comment), the
 * attested key is the exact key this request is binding (not just *some*
 * hardware-attested key), the leaf's attestationChallenge equals this
 * request's binding, the key is hardware-backed (TrustedEnvironment or
 * StrongBox, never Software), generated on-device (never imported),
 * SIGN-only EC/P-256, enrolled with biometric-only per-use authentication
 * (no device-credential fallback, no "no auth required", no time-bound
 * validity window), requires the device to be unlocked, the device's boot
 * state is verified and unmodified, the app-signing certificate AND
 * package name are on the allowlist, and no certificate in the chain is
 * revoked.
 */
export async function verifyAndroidKeyAttestation(input: AndroidKeyAttestationInput): Promise<void> {
  if (input.certificateChain.length === 0) {
    throw new AndroidAttestationInvalidError("empty certificate chain");
  }
  if (input.pinnedRootCertificates.length === 0) {
    throw new AndroidAttestationInvalidError("no pinned attestation roots configured");
  }

  const now = input.now ?? new Date();
  const chain = input.certificateChain.map((base64Der) => parseCertificate(base64Der));
  const roots = input.pinnedRootCertificates.map((base64Der) => parseCertificate(base64Der));

  await verifyChainOfTrust(chain, roots, now);
  await verifyNotRevoked(chain, input.revocationList);

  const leaf = chain[0]!;
  await verifyLeafKeyMatches(leaf, input.bioJkt);

  const keyDescription = extractKeyDescription(leaf);

  if (
    keyDescription.attestationVersion < MINIMUM_ATTESTATION_VERSION ||
    keyDescription.keymasterVersion < MINIMUM_ATTESTATION_VERSION
  ) {
    throw new AndroidAttestationInvalidError(
      `attestation version is below the minimum this verifier accepts (${MINIMUM_ATTESTATION_VERSION})`,
    );
  }

  if (
    !HARDWARE_SECURITY_LEVELS.has(keyDescription.attestationSecurityLevel) ||
    !HARDWARE_SECURITY_LEVELS.has(keyDescription.keymasterSecurityLevel)
  ) {
    throw new AndroidAttestationInvalidError(
      "key is not hardware-backed (TrustedEnvironment or StrongBox)",
    );
  }

  // The binding (SHA-256(challenge + "." + bioJkt)) is what Play Integrity's
  // requestHash is checked against, separately, in verifyPlayIntegrityToken
  // -- key attestation itself binds to the raw challenge via
  // attestationChallenge, not the binding hash.
  const attestedChallenge = Buffer.from(keyDescription.attestationChallenge).toString("ascii");
  if (attestedChallenge !== input.challenge) {
    throw new AndroidAttestationChallengeMismatchError();
  }

  const tee = keyDescription.teeEnforced;

  if (tee.noAuthRequired || keyDescription.softwareEnforced.noAuthRequired) {
    throw new AndroidAttestationInvalidError("key requires no authentication to use");
  }

  const userAuthType = tee.userAuthType;
  if (userAuthType === undefined) {
    throw new AndroidAttestationInvalidError("no user-authentication requirement attested");
  }
  if ((userAuthType & AUTH_TYPE_PASSWORD_BIT) !== 0) {
    throw new AndroidAttestationInvalidError(
      "key accepts device-credential authentication, not biometric-only",
    );
  }
  if ((userAuthType & AUTH_TYPE_FINGERPRINT_BIT) === 0) {
    throw new AndroidAttestationInvalidError("key does not require biometric authentication");
  }

  // authTimeout absent (or explicitly 0) means "authenticate before every
  // use" -- any other value is a time-bound validity window, which #19's
  // key spec never sets and this policy never accepts.
  if (tee.authTimeout !== undefined && tee.authTimeout !== 0) {
    throw new AndroidAttestationInvalidError("key does not require authentication on every use");
  }

  if (tee.allowWhileOnBody || keyDescription.softwareEnforced.allowWhileOnBody) {
    throw new AndroidAttestationInvalidError("key is usable without authentication while on-body");
  }

  // unlockedDeviceRequired (tag 509) was *intended* to be hardware-enforced,
  // but AOSP's own KeyMint Tag.aidl documents that support for that was
  // "never enabled by Keystore" and is deprecated as a concept -- on real
  // devices (Keymaster 4.0 through current KeyMint) it's Keystore-enforced
  // and attested in the SOFTWARE-enforced list, not the hardware one, at
  // every attestationVersion, not just 3. Requiring the hardware list would
  // reject essentially every real Android phone, this PR's own Xiaomi test
  // device included (KeyMint 2.0, attestationVersion 200). Accepting it
  // from Keystore is fine here specifically because the RootOfTrust check
  // below (deviceLocked + Verified boot) already establishes hardware trust
  // in the platform enforcing it -- unlike userAuthType (biometric), which
  // Tag.aidl says "must be hardware-enforced" and stays hardware-only.
  if (!tee.unlockedDeviceRequired && !keyDescription.softwareEnforced.unlockedDeviceRequired) {
    throw new AndroidAttestationInvalidError("key does not require the device to be unlocked");
  }

  if (tee.origin !== KM_ORIGIN_GENERATED) {
    throw new AndroidAttestationInvalidError("key was not generated on-device (imported or unknown origin)");
  }

  if (tee.purpose === undefined || tee.purpose.length !== 1 || tee.purpose[0] !== KM_PURPOSE_SIGN) {
    throw new AndroidAttestationInvalidError("key purpose is not SIGN-only");
  }
  if (tee.algorithm !== KM_ALGORITHM_EC) {
    throw new AndroidAttestationInvalidError("key algorithm is not EC");
  }
  if (tee.ecCurve !== KM_EC_CURVE_P256) {
    throw new AndroidAttestationInvalidError("key curve is not P-256");
  }
  if (tee.digest === undefined || !tee.digest.includes(KM_DIGEST_SHA_2_256)) {
    throw new AndroidAttestationInvalidError("key does not attest SHA-256 as an allowed digest");
  }

  if (tee.rootOfTrust === undefined) {
    throw new AndroidAttestationInvalidError("no hardware-enforced root of trust attested");
  }
  if (!tee.rootOfTrust.deviceLocked) {
    throw new AndroidAttestationInvalidError("the device's bootloader is unlocked");
  }
  if (tee.rootOfTrust.verifiedBootState !== VERIFIED_BOOT_STATE_VERIFIED) {
    throw new AndroidAttestationInvalidError("the device's verified boot state is not Verified");
  }

  const applicationId =
    keyDescription.softwareEnforced.attestationApplicationId ??
    keyDescription.teeEnforced.attestationApplicationId;
  if (applicationId === undefined) {
    throw new AndroidAttestationInvalidError("no attestationApplicationId present");
  }
  const { packageNames, signatureDigests } = parseAttestationApplicationId(applicationId);
  if (!packageNames.includes("com.vistablox.app")) {
    throw new AndroidAttestationInvalidError("attested package name is not com.vistablox.app");
  }
  const allowlist = new Set(input.certDigestAllowlist.map(normalizeCertDigest));
  const matches = signatureDigests.some((digest) => allowlist.has(normalizeCertDigest(digest)));
  if (!matches) {
    throw new AndroidAttestationInvalidError("app signing certificate is not on the allowlist");
  }
}

export type PlayIntegrityPolicy = "disabled" | "relaxed" | "strict";

export interface PlayIntegrityVerdictDecoder {
  decode(token: string): Promise<{
    requestHash: string | undefined;
    appRecognitionVerdict: string;
    deviceRecognitionVerdicts: string[];
    certificateSha256Digests: string[];
  }>;
}

/**
 * Verifies a Play Integrity standard-request token per the contract and
 * DevOps's interim policy table. `disabled` skips this entirely (staging,
 * no Play Console project yet) -- Android key attestation above is the
 * whole signal in that mode. `relaxed` additionally accepts
 * `UNRECOGNIZED_VERSION` (sideloaded builds); `strict` requires
 * `PLAY_RECOGNIZED`. The binding (requestHash) check is never relaxed.
 */
export async function verifyPlayIntegrityToken(input: {
  policy: PlayIntegrityPolicy;
  token: string | undefined;
  challenge: string;
  bioJkt: string;
  certDigestAllowlist: string[];
  decoder: PlayIntegrityVerdictDecoder;
}): Promise<void> {
  if (input.policy === "disabled") return;
  if (input.token === undefined) {
    throw new AndroidAttestationInvalidError("integrity_token is required by the current policy");
  }

  let verdict: Awaited<ReturnType<PlayIntegrityVerdictDecoder["decode"]>>;
  try {
    verdict = await input.decoder.decode(input.token);
  } catch {
    throw new AndroidAttestationInvalidError("Play Integrity token could not be decoded");
  }
  const expectedRequestHash = computeDeviceBinding(input.challenge, input.bioJkt);
  if (verdict.requestHash !== expectedRequestHash) {
    throw new AndroidAttestationInvalidError("Play Integrity requestHash does not match the binding");
  }

  const acceptedAppVerdicts =
    input.policy === "relaxed" ? ["PLAY_RECOGNIZED", "UNRECOGNIZED_VERSION"] : ["PLAY_RECOGNIZED"];
  if (!acceptedAppVerdicts.includes(verdict.appRecognitionVerdict)) {
    throw new AndroidAttestationInvalidError(
      `Play Integrity app recognition verdict "${verdict.appRecognitionVerdict}" is not accepted`,
    );
  }
  if (!verdict.deviceRecognitionVerdicts.includes("MEETS_DEVICE_INTEGRITY")) {
    throw new AndroidAttestationInvalidError("Play Integrity device recognition verdict is too weak");
  }
  const allowlist = new Set(input.certDigestAllowlist.map(normalizeCertDigest));
  const matches = verdict.certificateSha256Digests.some((digest) =>
    allowlist.has(normalizeCertDigest(digest)),
  );
  if (!matches) {
    throw new AndroidAttestationInvalidError(
      "Play Integrity certificate digest is not on the allowlist",
    );
  }
}

// Config and API-supplied digests both land here: a human-typed
// ANDROID_ATTESTATION_CERT_DIGESTS value commonly carries the colons
// `openssl`/Android tooling print fingerprints with (confirmed against
// staging -- the value had to be hand-stripped of colons to match), while a
// digest parsed from a certificate or a Play Integrity verdict never does.
// Stripping every non-hex character before comparing makes both sides
// tolerant of that formatting difference instead of silently never matching.
function normalizeCertDigest(value: string): string {
  return value.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

function parseCertificate(base64Der: string): X509Certificate {
  try {
    return new X509Certificate(Buffer.from(base64Der, "base64"));
  } catch {
    throw new AndroidAttestationInvalidError("malformed certificate in the chain");
  }
}

/**
 * Chain-of-trust to a pinned root. Beyond "each signature verifies and the
 * top matches a pinned root byte-for-byte" (the original, and still
 * necessary, checks), every certificate that signs another one in the
 * chain must actually be a CA authorized to do so: a genuine, ordinary
 * hardware-attested key (fully real chain, fully valid signature, no
 * forgery in that sense) is still just an end-entity leaf. Without a
 * basicConstraints(cA=true)+keyUsage(keyCertSign) check, an attacker's own
 * app can attest an ordinary key, then use its Keystore sign() operation to
 * sign an arbitrary "leaf" certificate underneath it, carrying any
 * KeyDescription they like (our challenge, StrongBox, biometric-only, our
 * app's digest) over a key that never touched real hardware at all --
 * verified against a real PoC during review. Path length and issuer/subject
 * name chaining close the same family of gap one step further (a CA can't
 * be reused past the depth it was authorized for, and "signature verifies"
 * alone doesn't mean "the certificate that signed you claims to BE your
 * stated issuer").
 */
async function verifyChainOfTrust(
  chain: X509Certificate[],
  pinnedRoots: X509Certificate[],
  now: Date,
): Promise<void> {
  for (let i = 0; i < chain.length; i++) {
    const certificate = chain[i]!;
    if (now < certificate.notBefore || now > certificate.notAfter) {
      throw new AndroidAttestationInvalidError("a certificate in the chain is expired or not yet valid");
    }
    const issuer = chain[i + 1];
    if (issuer !== undefined) {
      const issuerNameMatches = Buffer.from(certificate.issuerName.toArrayBuffer()).equals(
        Buffer.from(issuer.subjectName.toArrayBuffer()),
      );
      if (!issuerNameMatches) {
        throw new AndroidAttestationInvalidError(
          "a certificate's issuer name does not match the next certificate's subject",
        );
      }
      const signatureValid = await certificate.verify({ publicKey: issuer.publicKey, date: now });
      if (!signatureValid) {
        throw new AndroidAttestationInvalidError("chain signature verification failed");
      }

      const constraints = issuer.getExtension(BasicConstraintsExtension);
      if (constraints === null || !constraints.ca) {
        throw new AndroidAttestationInvalidError(
          "a certificate that signed another one in the chain is not marked as a CA",
        );
      }
      const keyUsage = issuer.getExtension(KeyUsagesExtension);
      if (keyUsage === null || (keyUsage.usages & KeyUsageFlags.keyCertSign) === 0) {
        throw new AndroidAttestationInvalidError(
          "a certificate that signed another one in the chain lacks the keyCertSign key usage",
        );
      }
      // pathLength is how many CA certificates may follow this one before
      // the end-entity leaf; `i` is exactly that count for the certificates
      // already consumed between the leaf (index 0, never counted itself)
      // and this issuer (index i + 1).
      if (constraints.pathLength !== undefined && i > constraints.pathLength) {
        throw new AndroidAttestationInvalidError(
          "the certificate chain exceeds an issuer's path length constraint",
        );
      }
      continue;
    }
    // Top of the supplied chain -- it must itself be one of the pinned
    // roots (compared by raw DER, not just issuer-name matching, so a
    // same-named-but-different-key root can never slip through).
    const isPinned = pinnedRoots.some((root) =>
      Buffer.from(root.rawData).equals(Buffer.from(certificate.rawData)),
    );
    if (!isPinned) {
      throw new AndroidAttestationInvalidError("chain does not terminate at a pinned root");
    }
  }
}

/**
 * The attested key must be the exact key this request is binding -- not
 * merely *some* validly-attested key. Without this, a genuinely
 * hardware-attested, correctly-chained certificate for a completely
 * unrelated key (the attacker's own, say) would pass every other check in
 * this file; bioJkt (computed from the JWS's own embedded/stored public
 * key, already verified separately) is the one thing that ties this
 * specific attestation to the specific key the enrolment/login JWS was
 * actually signed with.
 */
async function verifyLeafKeyMatches(leaf: X509Certificate, expectedBioJkt: string): Promise<void> {
  let jwk: JWK;
  try {
    const cryptoKey = await leaf.publicKey.export({ name: "ECDSA", namedCurve: "P-256" }, ["verify"]);
    jwk = (await webcrypto.subtle.exportKey("jwk", cryptoKey)) as JWK;
  } catch {
    throw new AndroidAttestationInvalidError("attested key is not an exportable EC P-256 public key");
  }
  const leafBioJkt = await calculateJwkThumbprint(jwk, "sha256");
  if (leafBioJkt !== expectedBioJkt) {
    throw new AndroidAttestationInvalidError(
      "attested key does not match the enrolling/authenticating device's key",
    );
  }
}

async function verifyNotRevoked(
  chain: X509Certificate[],
  revocationList: AndroidAttestationRevocationList,
): Promise<void> {
  for (const certificate of chain) {
    if (await revocationList.isRevoked(normalizeSerialHex(certificate.serialNumber))) {
      throw new AndroidAttestationInvalidError("a certificate in the chain is revoked");
    }
  }
}

// Google's revocation list keys serials by Java BigInteger.toString(16) --
// no leading zero nibble (a serial of 0x0abc is listed as "abc", not
// "0abc"). @peculiar/x509's own serialNumber getter keeps the full
// even-length hex byte string, so a serial in 0x01-0x0f (one leading zero
// nibble) would never match the list's own key as-is. BigInt round-tripping
// reproduces exactly the format Google's list uses.
function normalizeSerialHex(serialHex: string): string {
  return BigInt(`0x${serialHex}`).toString(16);
}

interface RootOfTrust {
  deviceLocked: boolean;
  verifiedBootState: number;
}

interface AuthorizationList {
  purpose: number[] | undefined;
  algorithm: number | undefined;
  digest: number[] | undefined;
  ecCurve: number | undefined;
  noAuthRequired: boolean;
  userAuthType: number | undefined;
  authTimeout: number | undefined;
  allowWhileOnBody: boolean;
  unlockedDeviceRequired: boolean;
  origin: number | undefined;
  rootOfTrust: RootOfTrust | undefined;
  attestationApplicationId: Uint8Array | undefined;
}

interface KeyDescription {
  attestationVersion: number;
  attestationSecurityLevel: number;
  keymasterVersion: number;
  keymasterSecurityLevel: number;
  attestationChallenge: Uint8Array;
  softwareEnforced: AuthorizationList;
  teeEnforced: AuthorizationList;
}

function extractKeyDescription(leaf: X509Certificate): KeyDescription {
  const extension = leaf.getExtension(KEY_DESCRIPTION_OID);
  if (extension === null) {
    throw new AndroidAttestationInvalidError("no key-attestation extension present");
  }

  const parsed = asn1js.fromBER(extension.value);
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    throw new AndroidAttestationInvalidError("malformed key-attestation extension");
  }
  const fields = parsed.result.valueBlock.value;
  if (fields.length < 8) {
    throw new AndroidAttestationInvalidError("key-attestation extension is missing fields");
  }

  const attestationVersion = readInteger(fields[0]);
  const attestationSecurityLevel = readEnumerated(fields[1]);
  const keymasterVersion = readInteger(fields[2]);
  const keymasterSecurityLevel = readEnumerated(fields[3]);
  const attestationChallenge = readOctetString(fields[4]);
  const softwareEnforced = parseAuthorizationList(fields[6]);
  const teeEnforced = parseAuthorizationList(fields[7]);

  return {
    attestationVersion,
    attestationSecurityLevel,
    keymasterVersion,
    keymasterSecurityLevel,
    attestationChallenge,
    softwareEnforced,
    teeEnforced,
  };
}

function parseAuthorizationList(node: unknown): AuthorizationList {
  if (!(node instanceof asn1js.Sequence)) {
    throw new AndroidAttestationInvalidError("malformed authorization list");
  }
  let purpose: number[] | undefined;
  let algorithm: number | undefined;
  let digest: number[] | undefined;
  let ecCurve: number | undefined;
  let noAuthRequired = false;
  let userAuthType: number | undefined;
  let authTimeout: number | undefined;
  let allowWhileOnBody = false;
  let unlockedDeviceRequired = false;
  let origin: number | undefined;
  let rootOfTrust: RootOfTrust | undefined;
  let attestationApplicationId: Uint8Array | undefined;

  for (const entry of node.valueBlock.value) {
    if (!(entry instanceof asn1js.Constructed) || entry.idBlock.tagClass !== 3) continue;
    const tagNumber = entry.idBlock.tagNumber;
    const inner = entry.valueBlock.value[0];
    if (tagNumber === TAG_PURPOSE && inner !== undefined) {
      purpose = readIntegerSet(inner);
    } else if (tagNumber === TAG_ALGORITHM && inner !== undefined) {
      algorithm = readInteger(inner);
    } else if (tagNumber === TAG_DIGEST && inner !== undefined) {
      digest = readIntegerSet(inner);
    } else if (tagNumber === TAG_EC_CURVE && inner !== undefined) {
      ecCurve = readInteger(inner);
    } else if (tagNumber === TAG_NO_AUTH_REQUIRED) {
      noAuthRequired = true;
    } else if (tagNumber === TAG_USER_AUTH_TYPE && inner !== undefined) {
      userAuthType = readInteger(inner);
    } else if (tagNumber === TAG_AUTH_TIMEOUT && inner !== undefined) {
      authTimeout = readInteger(inner);
    } else if (tagNumber === TAG_ALLOW_WHILE_ON_BODY) {
      allowWhileOnBody = true;
    } else if (tagNumber === TAG_UNLOCKED_DEVICE_REQUIRED) {
      unlockedDeviceRequired = true;
    } else if (tagNumber === TAG_ORIGIN && inner !== undefined) {
      origin = readInteger(inner);
    } else if (tagNumber === TAG_ROOT_OF_TRUST && inner !== undefined) {
      rootOfTrust = parseRootOfTrust(inner);
    } else if (tagNumber === TAG_ATTESTATION_APPLICATION_ID && inner !== undefined) {
      attestationApplicationId = readOctetString(inner);
    }
  }

  return {
    purpose,
    algorithm,
    digest,
    ecCurve,
    noAuthRequired,
    userAuthType,
    authTimeout,
    allowWhileOnBody,
    unlockedDeviceRequired,
    origin,
    rootOfTrust,
    attestationApplicationId,
  };
}

// RootOfTrust ::= SEQUENCE {
//   verifiedBootKey    OCTET_STRING,
//   deviceLocked       BOOLEAN,
//   verifiedBootState  ENUMERATED,
//   verifiedBootHash   OCTET_STRING,
// }
function parseRootOfTrust(node: unknown): RootOfTrust {
  if (!(node instanceof asn1js.Sequence) || node.valueBlock.value.length < 3) {
    throw new AndroidAttestationInvalidError("malformed root of trust");
  }
  const [, deviceLockedNode, verifiedBootStateNode] = node.valueBlock.value;
  if (!(deviceLockedNode instanceof asn1js.Boolean)) {
    throw new AndroidAttestationInvalidError("malformed root of trust: deviceLocked");
  }
  return {
    deviceLocked: deviceLockedNode.valueBlock.value,
    verifiedBootState: readEnumerated(verifiedBootStateNode),
  };
}

// AttestationApplicationId ::= SEQUENCE {
//   packageInfos SET OF SEQUENCE { packageName OCTET_STRING, version INTEGER },
//   signatureDigests SET OF OCTET_STRING,
// }
function parseAttestationApplicationId(
  raw: Uint8Array,
): { packageNames: string[]; signatureDigests: string[] } {
  const parsed = asn1js.fromBER(raw);
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    throw new AndroidAttestationInvalidError("malformed attestationApplicationId");
  }
  const [packageInfos, signatureDigests] = parsed.result.valueBlock.value;
  if (!(packageInfos instanceof asn1js.Set) || !(signatureDigests instanceof asn1js.Set)) {
    throw new AndroidAttestationInvalidError("malformed attestationApplicationId");
  }
  const packageNames = packageInfos.valueBlock.value.map((packageInfo) => {
    if (!(packageInfo instanceof asn1js.Sequence) || packageInfo.valueBlock.value.length < 1) {
      throw new AndroidAttestationInvalidError("malformed attestationApplicationId package info");
    }
    return Buffer.from(readOctetString(packageInfo.valueBlock.value[0])).toString("utf8");
  });
  return {
    packageNames,
    signatureDigests: signatureDigests.valueBlock.value.map((digest) =>
      Buffer.from(readOctetString(digest)).toString("hex"),
    ),
  };
}

function readEnumerated(node: unknown): number {
  if (!(node instanceof asn1js.Enumerated)) {
    throw new AndroidAttestationInvalidError("expected an ENUMERATED field");
  }
  return node.valueBlock.valueDec;
}

function readInteger(node: unknown): number {
  if (!(node instanceof asn1js.Integer)) {
    throw new AndroidAttestationInvalidError("expected an INTEGER field");
  }
  return node.valueBlock.valueDec;
}

function readIntegerSet(node: unknown): number[] {
  if (!(node instanceof asn1js.Set)) {
    throw new AndroidAttestationInvalidError("expected a SET OF INTEGER field");
  }
  return node.valueBlock.value.map((item) => readInteger(item));
}

function readOctetString(node: unknown): Uint8Array {
  if (!(node instanceof asn1js.OctetString)) {
    throw new AndroidAttestationInvalidError("expected an OCTET STRING field");
  }
  return node.valueBlock.valueHexView;
}

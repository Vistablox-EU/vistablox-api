import { webcrypto } from "node:crypto";

// @peculiar/x509 uses tsyringe internally, which throws at import time if
// this polyfill hasn't been loaded first -- must be the first import here,
// before anything else in this file touches @peculiar/x509.
import "reflect-metadata";

import * as asn1js from "asn1js";
import { cryptoProvider, X509Certificate } from "@peculiar/x509";

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

// AuthorizationList tag numbers (KeyMint/Keymaster HAL, stable since the
// attestation extension's inception). Only the ones this verifier actually
// reads.
const TAG_NO_AUTH_REQUIRED = 503;
const TAG_USER_AUTH_TYPE = 504;
const TAG_ATTESTATION_APPLICATION_ID = 709;

// HardwareAuthenticatorType bitmask (Keymaster HAL). AUTH_BIOMETRIC_STRONG
// enrolment attests as FINGERPRINT only; PASSWORD is the device-credential
// bit, which "biometrics mandatory, no fallback" must never see set.
const AUTH_TYPE_PASSWORD_BIT = 0b01;
const AUTH_TYPE_FINGERPRINT_BIT = 0b10;

// attestationSecurityLevel / keymasterSecurityLevel ENUMERATED values.
const SECURITY_LEVEL_SOFTWARE = 0;

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
 * beyond 72h.
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
  bioJkt: string;
  revocationList: AndroidAttestationRevocationList;
  now?: Date;
}

/**
 * Verifies an Android key-attestation certificate chain against the wire
 * contract: chain-of-trust to a pinned root, the leaf's attestationChallenge
 * equals this request's binding, the key is hardware-backed
 * (TrustedEnvironment or StrongBox, never Software), enrolled with
 * biometric-only user authentication (no device-credential fallback, no
 * "no auth required"), the app-signing certificate is on the allowlist, and
 * no certificate in the chain is revoked.
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
  const keyDescription = extractKeyDescription(leaf);

  if (
    keyDescription.attestationSecurityLevel === SECURITY_LEVEL_SOFTWARE ||
    keyDescription.keymasterSecurityLevel === SECURITY_LEVEL_SOFTWARE
  ) {
    throw new AndroidAttestationInvalidError("key is not hardware-backed");
  }

  // The binding (SHA-256(challenge + "." + bioJkt)) is what Play Integrity's
  // requestHash is checked against, separately, in verifyPlayIntegrityToken
  // -- key attestation itself binds to the raw challenge via
  // attestationChallenge, not the binding hash.
  const attestedChallenge = Buffer.from(keyDescription.attestationChallenge).toString("ascii");
  if (attestedChallenge !== input.challenge) {
    throw new AndroidAttestationChallengeMismatchError();
  }

  if (keyDescription.teeEnforced.noAuthRequired || keyDescription.softwareEnforced.noAuthRequired) {
    throw new AndroidAttestationInvalidError("key requires no authentication to use");
  }

  const userAuthType = keyDescription.teeEnforced.userAuthType;
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

  const applicationId =
    keyDescription.softwareEnforced.attestationApplicationId ??
    keyDescription.teeEnforced.attestationApplicationId;
  if (applicationId === undefined) {
    throw new AndroidAttestationInvalidError("no attestationApplicationId present");
  }
  const signingCertDigests = parseAttestationApplicationId(applicationId);
  const allowlist = new Set(input.certDigestAllowlist.map(normalizeCertDigest));
  const matches = signingCertDigests.some((digest) => allowlist.has(normalizeCertDigest(digest)));
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

  const verdict = await input.decoder.decode(input.token);
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
      const signatureValid = await certificate.verify({ publicKey: issuer.publicKey, date: now });
      if (!signatureValid) {
        throw new AndroidAttestationInvalidError("chain signature verification failed");
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

async function verifyNotRevoked(
  chain: X509Certificate[],
  revocationList: AndroidAttestationRevocationList,
): Promise<void> {
  for (const certificate of chain) {
    const serialHex = certificate.serialNumber.toLowerCase();
    if (await revocationList.isRevoked(serialHex)) {
      throw new AndroidAttestationInvalidError("a certificate in the chain is revoked");
    }
  }
}

interface AuthorizationList {
  noAuthRequired: boolean;
  userAuthType: number | undefined;
  attestationApplicationId: Uint8Array | undefined;
}

interface KeyDescription {
  attestationSecurityLevel: number;
  keymasterSecurityLevel: number;
  attestationChallenge: Uint8Array;
  softwareEnforced: AuthorizationList;
  teeEnforced: AuthorizationList;
}

function extractKeyDescription(leaf: X509Certificate): KeyDescription {
  const extension = leaf.getExtensions(KEY_DESCRIPTION_OID)[0];
  if (extension === undefined) {
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

  const attestationSecurityLevel = readEnumerated(fields[1]);
  const keymasterSecurityLevel = readEnumerated(fields[3]);
  const attestationChallenge = readOctetString(fields[4]);
  const softwareEnforced = parseAuthorizationList(fields[6]);
  const teeEnforced = parseAuthorizationList(fields[7]);

  return {
    attestationSecurityLevel,
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
  let noAuthRequired = false;
  let userAuthType: number | undefined;
  let attestationApplicationId: Uint8Array | undefined;

  for (const entry of node.valueBlock.value) {
    if (!(entry instanceof asn1js.Constructed) || entry.idBlock.tagClass !== 3) continue;
    const tagNumber = entry.idBlock.tagNumber;
    const inner = entry.valueBlock.value[0];
    if (tagNumber === TAG_NO_AUTH_REQUIRED) {
      noAuthRequired = true;
    } else if (tagNumber === TAG_USER_AUTH_TYPE && inner !== undefined) {
      userAuthType = readInteger(inner);
    } else if (tagNumber === TAG_ATTESTATION_APPLICATION_ID && inner !== undefined) {
      attestationApplicationId = readOctetString(inner);
    }
  }

  return { noAuthRequired, userAuthType, attestationApplicationId };
}

// AttestationApplicationId ::= SEQUENCE {
//   packageInfos SET OF SEQUENCE { packageName OCTET_STRING, version INTEGER },
//   signatureDigests SET OF OCTET_STRING,
// }
function parseAttestationApplicationId(raw: Uint8Array): string[] {
  const parsed = asn1js.fromBER(raw);
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    throw new AndroidAttestationInvalidError("malformed attestationApplicationId");
  }
  const [, signatureDigests] = parsed.result.valueBlock.value;
  if (!(signatureDigests instanceof asn1js.Set)) {
    throw new AndroidAttestationInvalidError("malformed attestationApplicationId signature digests");
  }
  return signatureDigests.valueBlock.value.map((digest) =>
    Buffer.from(readOctetString(digest)).toString("hex"),
  );
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

function readOctetString(node: unknown): Uint8Array {
  if (!(node instanceof asn1js.OctetString)) {
    throw new AndroidAttestationInvalidError("expected an OCTET STRING field");
  }
  return node.valueBlock.valueHexView;
}

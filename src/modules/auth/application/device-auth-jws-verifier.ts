import { type JWK, calculateJwkThumbprint, importJWK, jwtVerify } from "jose";

const IAT_WINDOW_SECONDS = 60;
const JWS_TYP = "vistablox-device-auth+jwt";

export class DeviceJwsInvalidError extends Error {
  public readonly code = "DEVICE_JWS_INVALID" as const;
  public constructor(reason: string) {
    super(`Device-auth JWS rejected: ${reason}`);
    this.name = "DeviceJwsInvalidError";
  }
}

export class DeviceChallengePurposeMismatchError extends Error {
  public readonly code = "DEVICE_CHALLENGE_PURPOSE_MISMATCH" as const;
  public constructor() {
    super("The challenge's purpose does not match the JWS's purpose claim.");
    this.name = "DeviceChallengePurposeMismatchError";
  }
}

export type DeviceAuthJwsVerificationError =
  | DeviceJwsInvalidError
  | DeviceChallengePurposeMismatchError;

export function isDeviceAuthJwsVerificationError(
  error: unknown,
): error is DeviceAuthJwsVerificationError {
  return (
    error instanceof DeviceJwsInvalidError || error instanceof DeviceChallengePurposeMismatchError
  );
}

export interface DeviceAuthJwsClaims {
  bioJkt: string;
  purpose: string;
  challenge: string;
  deviceId: string | undefined;
  /** Only present on the `enrol-device` purpose. */
  jwk: JWK | undefined;
}

function isPublicP256Jwk(value: unknown): value is JWK {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).kty === "EC" &&
    (value as Record<string, unknown>).crv === "P-256" &&
    typeof (value as Record<string, unknown>).x === "string" &&
    typeof (value as Record<string, unknown>).y === "string" &&
    !("d" in (value as Record<string, unknown>))
  );
}

/**
 * Verifies a device-auth JWS (contract section 3.2): JOSE header
 * (`typ: "vistablox-device-auth+jwt"`, `alg: "ES256"`, `kid`; `enrol-device`
 * additionally embeds a public-only P-256 `jwk`), signature, and claims
 * (`purpose` matches the challenge it was issued for, `challenge` matches
 * exactly, `iat` within +/-60s, `device_id` when the caller expects one).
 * For every purpose except `enrol-device`, verification is against
 * `storedPublicJwk` -- the key on file for the device, never a
 * client-embedded one. Does not consume the challenge; the caller does that
 * atomically via DeviceChallengeRepository, separately.
 */
export async function verifyDeviceAuthJws(input: {
  jws: string;
  expectedPurpose: string;
  expectedChallenge: string;
  expectedDeviceId: string | undefined;
  /** Required for every purpose except `enrol-device`. */
  storedPublicJwk: JWK | undefined;
  now?: Date;
}): Promise<DeviceAuthJwsClaims> {
  const jws = input.jws.trim();
  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new DeviceJwsInvalidError("malformed JWS");
  }

  let protectedHeader: { typ?: unknown; alg?: unknown; kid?: unknown; jwk?: unknown };
  try {
    protectedHeader = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
  } catch {
    throw new DeviceJwsInvalidError("malformed protected header");
  }

  if (protectedHeader.typ !== JWS_TYP) {
    throw new DeviceJwsInvalidError("unexpected typ");
  }
  if (protectedHeader.alg !== "ES256") {
    throw new DeviceJwsInvalidError("unsupported alg");
  }
  if (typeof protectedHeader.kid !== "string" || protectedHeader.kid.length === 0) {
    throw new DeviceJwsInvalidError("missing kid");
  }

  const isEnrolDevice = input.expectedPurpose === "enrol-device";
  let verificationKey: JWK;
  if (isEnrolDevice) {
    if (!isPublicP256Jwk(protectedHeader.jwk)) {
      throw new DeviceJwsInvalidError(
        "enrol-device requires an embedded public P-256 jwk with no private members",
      );
    }
    verificationKey = protectedHeader.jwk;
  } else {
    if (protectedHeader.jwk !== undefined) {
      throw new DeviceJwsInvalidError("jwk must not be embedded outside enrol-device");
    }
    if (input.storedPublicJwk === undefined) {
      throw new DeviceJwsInvalidError("no stored key available to verify against");
    }
    verificationKey = input.storedPublicJwk;
  }

  const bioJkt = await calculateJwkThumbprint(verificationKey, "sha256");
  if (protectedHeader.kid !== bioJkt) {
    throw new DeviceJwsInvalidError("kid does not match the verification key's thumbprint");
  }

  let payload: Record<string, unknown>;
  try {
    const key = await importJWK(verificationKey, "ES256");
    const result = await jwtVerify(jws, key, { algorithms: ["ES256"] });
    payload = result.payload;
  } catch {
    throw new DeviceJwsInvalidError("signature verification failed");
  }

  if (typeof payload.purpose !== "string" || payload.purpose !== input.expectedPurpose) {
    throw new DeviceChallengePurposeMismatchError();
  }
  if (typeof payload.challenge !== "string" || payload.challenge !== input.expectedChallenge) {
    throw new DeviceJwsInvalidError("challenge mismatch");
  }
  const now = input.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (typeof payload.iat !== "number" || Math.abs(nowSeconds - payload.iat) > IAT_WINDOW_SECONDS) {
    throw new DeviceJwsInvalidError("iat outside the allowed window");
  }
  if (input.expectedDeviceId !== undefined) {
    if (typeof payload.device_id !== "string" || payload.device_id !== input.expectedDeviceId) {
      throw new DeviceJwsInvalidError("device_id mismatch");
    }
  }

  return {
    bioJkt,
    purpose: payload.purpose,
    challenge: payload.challenge,
    deviceId: typeof payload.device_id === "string" ? payload.device_id : undefined,
    jwk: isEnrolDevice ? verificationKey : undefined,
  };
}

import { createHash } from "node:crypto";

import { EmbeddedJWK, calculateJwkThumbprint, jwtVerify } from "jose";

const IAT_WINDOW_SECONDS = 60;
// base64url charset, generous bounds around the contract's "128-bit random,
// base64url" jti -- this validates shape, not that a client actually used
// 128 bits of entropy, which the server has no way to check.
const JTI_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export class DpopProofMissingError extends Error {
  public readonly code = "DPOP_PROOF_MISSING" as const;
  public constructor() {
    super("No DPoP proof was presented for a request that requires one.");
    this.name = "DpopProofMissingError";
  }
}

export class DpopProofInvalidError extends Error {
  public readonly code = "DPOP_PROOF_INVALID" as const;
  public constructor(reason: string) {
    super(`DPoP proof rejected: ${reason}`);
    this.name = "DpopProofInvalidError";
  }
}

export class DpopReplayError extends Error {
  public readonly code = "DPOP_REPLAY" as const;
  public constructor() {
    super("This DPoP proof (jkt, jti) has already been used.");
    this.name = "DpopReplayError";
  }
}

export class DpopKeyMismatchError extends Error {
  public readonly code = "DPOP_KEY_MISMATCH" as const;
  public constructor() {
    super("The DPoP proof's key does not match the one this session is bound to.");
    this.name = "DpopKeyMismatchError";
  }
}

export interface DpopProofClaims {
  jkt: string;
  jti: string;
}

// Observability: a jkt is a public key thumbprint, not a secret, but a
// truncated form is still enough to correlate log lines for one device
// without the full value showing up verbatim in every entry. Never pass a
// proof, a bearer token, or an ath value to a DpopLogger call -- callers
// only ever get jkt/code/path/sessionId here, by construction.
export function jktFingerprint(jkt: string): string {
  return jkt.slice(0, 12);
}

export interface DpopLogger {
  /** A session was bound (or newly bound on first sight) to a key. */
  bound(input: { sessionId: string; jkt: string }): void;
  /** A DPoP proof was rejected: missing, invalid, replayed, or a key mismatch. */
  rejected(input: { code: string; path: string }): void;
}

export const DPOP_WWW_AUTHENTICATE = 'DPoP error="invalid_dpop_proof"';

export type DpopVerificationError =
  | DpopProofMissingError
  | DpopProofInvalidError
  | DpopReplayError
  | DpopKeyMismatchError;

export function isDpopVerificationError(error: unknown): error is DpopVerificationError {
  return (
    error instanceof DpopProofMissingError ||
    error instanceof DpopProofInvalidError ||
    error instanceof DpopReplayError ||
    error instanceof DpopKeyMismatchError
  );
}

/** Shared 401 body fields for any of the four DPoP failure modes, envelope-agnostic. */
export function dpopErrorResponseFields(
  error: DpopVerificationError,
): { code: string; title: string; detail: string } {
  const titles: Record<DpopVerificationError["code"], string> = {
    DPOP_PROOF_MISSING: "DPoP proof required",
    DPOP_PROOF_INVALID: "DPoP proof invalid",
    DPOP_REPLAY: "DPoP proof already used",
    DPOP_KEY_MISMATCH: "DPoP key mismatch",
  };
  return { code: error.code, title: titles[error.code], detail: error.message };
}

/**
 * Canonical `htu` for a request: scheme + lower-cased host (default port
 * omitted) + the path exactly as sent (percent-encoding kept, no query or
 * fragment). `baseUrl` should be BETTER_AUTH_URL, never a value derived from
 * request headers -- the API has no `trust proxy` configured, so
 * `X-Forwarded-*`/`req.protocol`/`req.get('host')` are not trustworthy here.
 */
export function buildHtu(baseUrl: string, rawPathWithMaybeQuery: string): string {
  const base = new URL(baseUrl);
  const path = rawPathWithMaybeQuery.split(/[?#]/, 1)[0] ?? "";
  const isDefaultPort =
    base.port === "" ||
    (base.protocol === "https:" && base.port === "443") ||
    (base.protocol === "http:" && base.port === "80");
  const host = isDefaultPort ? base.hostname.toLowerCase() : `${base.hostname.toLowerCase()}:${base.port}`;
  return `${base.protocol}//${host}${path}`;
}

/**
 * Verifies a DPoP proof JWT against the wire contract: JOSE header
 * (`typ: "dpop+jwt"`, `alg: "ES256"`, an embedded public-only EC P-256 jwk),
 * signature, and claims (`htm`, `htu`, `iat` within +/-60s, `jti` shape,
 * `ath` when a bearer token is present). Does not check replay -- that's a
 * stateful concern the caller handles via DpopReplayRepository.recordProof
 * with the returned jti, throwing DpopReplayError on a `false` result.
 */
export async function verifyDpopProof(input: {
  header: string | undefined;
  method: string;
  url: string;
  bearerToken: string | undefined;
  now?: Date;
}): Promise<DpopProofClaims> {
  const header = input.header?.trim();
  if (header === undefined || header === "") {
    throw new DpopProofMissingError();
  }

  const parts = header.split(".");
  if (parts.length !== 3) {
    throw new DpopProofInvalidError("malformed proof");
  }

  let protectedHeader: { typ?: unknown; alg?: unknown; jwk?: unknown };
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    // JSON.parse("null")/("42")/("\"x\"") all succeed with no exception --
    // a base64url-encoded "null" header would otherwise reach `.typ` below
    // on a null value and throw an uncaught TypeError instead of the clean
    // 400 every other malformed-header case gets.
    if (typeof parsed !== "object" || parsed === null) {
      throw new DpopProofInvalidError("malformed protected header");
    }
    protectedHeader = parsed;
  } catch (error) {
    if (error instanceof DpopProofInvalidError) throw error;
    throw new DpopProofInvalidError("malformed protected header");
  }

  if (protectedHeader.typ !== "dpop+jwt") {
    throw new DpopProofInvalidError("unexpected typ");
  }
  if (protectedHeader.alg !== "ES256") {
    throw new DpopProofInvalidError("unsupported alg");
  }

  const jwk = protectedHeader.jwk;
  if (
    typeof jwk !== "object" ||
    jwk === null ||
    Array.isArray(jwk) ||
    (jwk as Record<string, unknown>).kty !== "EC" ||
    (jwk as Record<string, unknown>).crv !== "P-256" ||
    typeof (jwk as Record<string, unknown>).x !== "string" ||
    typeof (jwk as Record<string, unknown>).y !== "string" ||
    "d" in (jwk as Record<string, unknown>)
  ) {
    throw new DpopProofInvalidError("jwk is missing, not a public P-256 EC key, or carries private members");
  }

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(header, EmbeddedJWK, { algorithms: ["ES256"] });
    payload = result.payload;
  } catch {
    throw new DpopProofInvalidError("signature verification failed");
  }

  if (typeof payload.htm !== "string" || payload.htm !== input.method.toUpperCase()) {
    throw new DpopProofInvalidError("htm mismatch");
  }
  if (typeof payload.htu !== "string" || payload.htu !== input.url) {
    throw new DpopProofInvalidError("htu mismatch");
  }
  const now = input.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (typeof payload.iat !== "number" || Math.abs(nowSeconds - payload.iat) > IAT_WINDOW_SECONDS) {
    throw new DpopProofInvalidError("iat outside the allowed window");
  }
  if (typeof payload.jti !== "string" || !JTI_PATTERN.test(payload.jti)) {
    throw new DpopProofInvalidError("invalid jti");
  }
  if (input.bearerToken !== undefined) {
    // Hashed before any %-decoding bearer() itself applies to the header --
    // the contract fixes ath to the exact characters sent after "Bearer ".
    const expectedAth = createHash("sha256").update(input.bearerToken, "ascii").digest("base64url");
    if (payload.ath !== expectedAth) {
      throw new DpopProofInvalidError("ath mismatch");
    }
  }

  const jkt = await calculateJwkThumbprint(jwk as Parameters<typeof calculateJwkThumbprint>[0], "sha256");
  return { jkt, jti: payload.jti };
}

export type DpopSessionDecision = { action: "pass" } | { action: "bind"; jkt: string };

/**
 * The shared bound/unbound decision for a session that already exists,
 * given the request's proof material and the session's own binding state.
 * Framework-agnostic (env/Express and better-auth callers each extract
 * header/method/url/bearerToken their own way and act on the "bind" result
 * their own way -- SessionResolver.bindDpopKey vs.
 * internalAdapter.updateSession) -- this is only the policy: bound sessions
 * require a fresh, matching, unreplayed proof (throws otherwise); unbound
 * sessions never require one, but opportunistically bind on a valid one
 * from a pre-cutover session, and refuse (DpopKeyMismatchError) a valid one
 * from a session created after the cutover, since that combination is an
 * anomaly rather than a migration case.
 */
export async function decideDpopForSession(input: {
  header: string | undefined;
  method: string;
  url: string;
  bearerToken: string | undefined;
  boundJkt: string | null;
  sessionCreatedAt: Date;
  phase1CutoverAt: Date | undefined;
  recordProof: (jkt: string, jti: string, expiresAt: Date) => Promise<boolean>;
  replayWindowSeconds?: number;
}): Promise<DpopSessionDecision> {
  const replayWindowSeconds = input.replayWindowSeconds ?? 120;
  const record = (claims: DpopProofClaims): Promise<boolean> =>
    input.recordProof(claims.jkt, claims.jti, new Date(Date.now() + replayWindowSeconds * 1000));

  if (input.boundJkt !== null) {
    const claims = await verifyDpopProof({
      header: input.header,
      method: input.method,
      url: input.url,
      bearerToken: input.bearerToken,
    });
    if (claims.jkt !== input.boundJkt) throw new DpopKeyMismatchError();
    const accepted = await record(claims);
    if (!accepted) throw new DpopReplayError();
    return { action: "pass" };
  }

  if (input.header === undefined) return { action: "pass" };
  let claims: DpopProofClaims;
  try {
    claims = await verifyDpopProof({
      header: input.header,
      method: input.method,
      url: input.url,
      bearerToken: input.bearerToken,
    });
  } catch {
    return { action: "pass" };
  }

  const isPreCutover =
    input.phase1CutoverAt === undefined || input.sessionCreatedAt < input.phase1CutoverAt;
  if (!isPreCutover) throw new DpopKeyMismatchError();

  const accepted = await record(claims);
  if (!accepted) return { action: "pass" };

  return { action: "bind", jkt: claims.jkt };
}

import { APIError } from "better-auth/api";

import {
  DPOP_WWW_AUTHENTICATE,
  DpopKeyMismatchError,
  DpopProofMissingError,
  DpopReplayError,
  buildHtu,
  dpopErrorResponseFields,
  isDpopVerificationError,
  verifyDpopProof,
  type DpopLogger,
  type DpopProofClaims,
  type DpopVerificationError,
} from "../application/dpop-proof-verifier.js";
import type { DpopReplayRepository } from "../repository/dpop-replay.repository.js";

// Same shape as BetterAuthFactoryOptions["dpop"] -- duplicated rather than
// imported from better-auth.factory.ts on purpose, the same way
// better-auth-dpop.plugin.ts already defines its own options type instead
// of importing the factory's: this module is used *by* the factory (for
// session.create.before) and *by* the device-auth plugin, so it can't
// depend on either without creating a circular import between them (caught
// by `npm run architecture`, not a style preference).
export interface DpopSessionCreationOptions {
  baseUrl: string;
  replayRepository: DpopReplayRepository;
  replayWindowSeconds?: number;
  phase1CutoverAt?: Date;
  logger?: DpopLogger;
}

// Minimal structural subset of GenericEndpointContext (from @better-auth/core,
// a transitive dependency we don't import types from directly) -- headers
// and request are both genuinely optional there too: absent for internal
// auth.api.*({ headers }) calls (no request) and, in principle, for a call
// with neither. Real HTTP calls (sign-in, passkey verify, device-auth
// enrol/login) carry both.
export interface DpopCreationContext {
  headers?: Headers | undefined;
  request?: Request | undefined;
  path?: string | undefined;
}

// These four endpoints each do their own full, explicit DPoP verification
// (assertDpopKeyMatchesPendingSession / requireDpopProofForSessionCreation,
// below) as part of a "resolve or upgrade this specific pending session"
// ceremony -- better-auth-dpop.plugin.ts's generic before-hook must not
// ALSO verify+record for these paths. Two independent reasons, found
// together during the #54 security review:
//   1. Both would try to record the identical (jkt, jti) for the same
//      request; the second one always loses as a replay of the first
//      (DPOP_REPLAY on every real client).
//   2. The generic hook's own "session unbound -> auto-bind whatever key
//      shows up" behavior is deliberately permissive (correct for ordinary
//      Phase 1 traffic), but wrong here: a stolen oauth_pending bearer
//      token plus an attacker's own arbitrary DPoP key would auto-bind
//      before the ceremony's own explicit check ever runs. These paths
//      must reject an unbound (or mismatched) pending session outright,
//      not silently bind to whatever key happens to show up.
export function isSessionUpgradeCeremonyPath(path: string | undefined): boolean {
  return (
    path === "/passkey/verify-authentication" ||
    path === "/passkey/verify-registration" ||
    path === "/device/enrol/verify" ||
    path === "/device/login/verify"
  );
}

// The passkey verify-* ceremonies (and now the device-auth enrol/login
// endpoints) verify -- and replay-record -- the request's DPoP proof once
// already, in assertDpopKeyMatchesPendingSession/
// requireDpopProofForSessionCreation, before internalAdapter.createSession
// runs and fires session.create.before for the very same request.
// Re-verifying there and recording the identical (jkt, jti) a second time
// would self-collide as a replay of itself -- discovered live on staging,
// the upgraded session silently landed unbound. Keyed on the underlying
// Fetch Request object, the one thing guaranteed stable and unique across
// every context wrapper for one HTTP call, so a genuinely separate later
// request (a real replay) still gets its own fresh verify-and-record.
const dpopClaimsByRequest = new WeakMap<Request, DpopProofClaims>();

/**
 * Verifies a DPoP proof presented at session creation and returns its jkt to
 * bind, or null if there's nothing to bind (no dpop config, no proof, an
 * internal non-HTTP call, or the proof doesn't verify). A verification
 * failure here never blocks sign-in -- Phase 1 only ever binds when
 * presented with something valid, it doesn't require it -- but it's still
 * logged as a warning rather than swallowed, so a session landing unbound
 * has a reason attached in the logs instead of just an absent bind line.
 */
export async function tryBindDpopAtCreation(
  context: DpopCreationContext | null,
  dpop: DpopSessionCreationOptions | undefined,
): Promise<string | null> {
  if (dpop === undefined) return null;

  if (context?.request !== undefined) {
    const alreadyVerified = dpopClaimsByRequest.get(context.request);
    if (alreadyVerified !== undefined) return alreadyVerified.jkt;
  }

  if (context?.headers === undefined || context.request === undefined) {
    return null;
  }
  const header = context.headers.get("dpop");
  if (header === null) return null;

  const authHeader = context.headers.get("authorization");
  const bearerToken =
    authHeader !== null && authHeader.slice(0, 7).toLowerCase() === "bearer "
      ? authHeader.slice(7)
      : undefined;

  try {
    const claims = await verifyDpopProof({
      header,
      method: context.request.method,
      url: buildHtu(dpop.baseUrl, new URL(context.request.url).pathname),
      bearerToken,
    });
    const accepted = await dpop.replayRepository.recordProof(
      claims.jkt,
      claims.jti,
      new Date(Date.now() + (dpop.replayWindowSeconds ?? 120) * 1000),
    );
    if (!accepted) {
      dpop.logger?.rejected({ code: "DPOP_REPLAY", path: context.path ?? "unknown" });
      return null;
    }
    return claims.jkt;
  } catch (error) {
    if (isDpopVerificationError(error)) {
      dpop.logger?.rejected({ code: error.code, path: context.path ?? "unknown" });
    }
    return null;
  }
}

/**
 * The passkey ceremony that upgrades a pending OAuth session must be
 * confirmed by the same device key the session is bound to -- otherwise a
 * different key (e.g. someone who intercepted the bearer token mid-OAuth)
 * could complete the upgrade the legitimate device started. Error codes stay
 * precise on purpose: DPOP_KEY_MISMATCH is the one code with client-side
 * behavior (delete the stored token, drop to sign-in), so it must mean
 * exactly "the proof verified but its key isn't this session's key" --
 * never a stand-in for a missing/malformed/replayed proof.
 */
export async function assertDpopKeyMatchesPendingSession(
  ctx: DpopCreationContext,
  boundJkt: string,
  dpop: DpopSessionCreationOptions | undefined,
): Promise<void> {
  const claims = await verifyAndCacheDpopProof(ctx, dpop);
  if (claims.jkt !== boundJkt) {
    throw dpopApiError(new DpopKeyMismatchError(), dpop, ctx);
  }
}

/**
 * Requires and verifies this request's DPoP proof, exactly the way
 * assertDpopKeyMatchesPendingSession does, but with no pre-existing bound
 * key to check it against -- for a ceremony that's about to create a *new*
 * session from scratch (device-key enrolment/login) rather than upgrade an
 * already-bound pending one. Same WeakMap caching, same reason: the
 * upcoming internalAdapter.createSession call fires session.create.before
 * for this identical request, and it must not re-verify-and-record the
 * same (jkt, jti) a second time (see dpopClaimsByRequest's own comment).
 */
export async function requireDpopProofForSessionCreation(
  ctx: DpopCreationContext,
  dpop: DpopSessionCreationOptions | undefined,
): Promise<DpopProofClaims> {
  return verifyAndCacheDpopProof(ctx, dpop);
}

async function verifyAndCacheDpopProof(
  ctx: DpopCreationContext,
  dpop: DpopSessionCreationOptions | undefined,
): Promise<DpopProofClaims> {
  const header = ctx.headers?.get("dpop") ?? undefined;
  const authHeader = ctx.headers?.get("authorization") ?? null;
  const bearerToken =
    authHeader !== null && authHeader.slice(0, 7).toLowerCase() === "bearer "
      ? authHeader.slice(7)
      : undefined;

  if (dpop === undefined || ctx.request === undefined) {
    throw dpopApiError(new DpopProofMissingError(), dpop, ctx);
  }

  let claims: DpopProofClaims;
  try {
    claims = await verifyDpopProof({
      header,
      method: ctx.request.method,
      url: buildHtu(dpop.baseUrl, new URL(ctx.request.url).pathname),
      bearerToken,
    });
  } catch (error) {
    if (isDpopVerificationError(error)) throw dpopApiError(error, dpop, ctx);
    throw error;
  }

  const accepted = await dpop.replayRepository.recordProof(
    claims.jkt,
    claims.jti,
    new Date(Date.now() + (dpop.replayWindowSeconds ?? 120) * 1000),
  );
  if (!accepted) {
    throw dpopApiError(new DpopReplayError(), dpop, ctx);
  }

  // This same request's session.create.before is about to run (the
  // ceremony calls internalAdapter.createSession right after this
  // succeeds) -- hand it the already-verified, already-recorded claims so
  // it binds the new session without re-verifying and double-recording
  // the identical (jkt, jti) against itself.
  if (ctx.request !== undefined) {
    dpopClaimsByRequest.set(ctx.request, claims);
  }

  return claims;
}

function dpopApiError(
  error: DpopVerificationError,
  dpop: DpopSessionCreationOptions | undefined,
  ctx: DpopCreationContext,
): APIError {
  const { code, title, detail } = dpopErrorResponseFields(error);
  dpop?.logger?.rejected({ code, path: ctx.path ?? "unknown" });
  return new APIError(
    "UNAUTHORIZED",
    { code, message: `${title}: ${detail}` },
    { "WWW-Authenticate": DPOP_WWW_AUTHENTICATE },
  );
}

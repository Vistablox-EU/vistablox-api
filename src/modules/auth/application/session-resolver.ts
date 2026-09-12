import type { IncomingHttpHeaders } from "node:http";

import { AppError } from "../../../shared/errors/app-error.js";

export interface AuthenticatedIdentity {
  betterAuthUserId: string;
  providerSessionId: string;
  population: "customer" | "staff_partner";
  // Device binding (DPoP): the RFC 7638 thumbprint of the key this session
  // is bound to, or null for an unbound session (no proof was presented at
  // creation). Non-null means requireAuthentication must verify a fresh
  // DPoP proof against it on every request.
  dpopJkt: string | null;
  // When this session was created -- decides, for an unbound session, which
  // side of the phase-1 cutover it's on (see DPOP_PHASE1_CUTOVER_AT).
  sessionCreatedAt: Date;
  // The session's authentication level (e.g. "device_biometric"), when the
  // resolver knows it. Lets recordActivity skip sessions without an idle
  // limit without touching the database.
  authenticationLevel?: string;
}

export interface SessionResolver {
  resolve(headers: IncomingHttpHeaders): Promise<AuthenticatedIdentity | null>;
  // Device binding (DPoP): binds a currently-unbound session to a key,
  // opportunistically, the first time it presents a valid proof on any
  // request (not just at creation) -- covers sessions that predate this
  // feature without forcing a re-sign-in. Optional because not every
  // SessionResolver implementation need support it.
  bindDpopKey?(providerSessionId: string, jkt: string): Promise<void>;
  // Session time limits (contract 3.6/3.7): records that this session was
  // just used by a fully authenticated request. requireAuthentication calls
  // it only after the DPoP proof and the account checks have passed, so a
  // request with a stolen bearer token but no matching DPoP key can't keep a
  // session from idling out. Implementations apply it only to sessions with
  // an idle limit (device_biometric) and leave every other session alone.
  // Optional for the same reason bindDpopKey is.
  recordActivity?(identity: AuthenticatedIdentity): Promise<void>;
}

/**
 * Contract 3.6: REAUTH_REQUIRED (401). A device session reached its idle or
 * absolute limit; the client runs device login, then replays the original
 * request once.
 */
export function reauthRequiredError(): AppError {
  return new AppError({
    code: "REAUTH_REQUIRED",
    title: "Sign-in required",
    status: 401,
    detail: "This session reached its time limit. Sign in on this device again.",
  });
}

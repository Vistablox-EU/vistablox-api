import type { RequestHandler } from "express";

import type { AccountRepository } from "../../account/repository/account.repository.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthenticatedIdentity, SessionResolver } from "../application/session-resolver.js";
import type { DpopReplayRepository } from "../repository/dpop-replay.repository.js";
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
} from "../application/dpop-proof-verifier.js";

export interface DpopEnforcementOptions {
  baseUrl: string;
  replayRepository: DpopReplayRepository;
  // How long a (jkt, jti) pair stays in the replay table -- must be at
  // least as generous as the proof's own +/-60s freshness window, plus a
  // margin so clock skew between verification and the insert can't shrink
  // the effective window below that.
  replayWindowSeconds?: number;
  // The one-time historical line (DPOP_PHASE1_CUTOVER_AT) separating
  // sessions old enough to have never had a chance to bind at creation
  // (eligible for opportunistic bind-on-first-sight) from ones created
  // after mobile could already send a proof, where an unbound session
  // presenting one now is an anomaly, not a migration case. Undefined
  // treats every unbound session as pre-cutover (safe only before phase 1
  // has actually shipped to mobile).
  phase1CutoverAt?: Date;
  logger?: DpopLogger;
}

export function createRequireAuthentication(
  sessions: SessionResolver,
  accounts: AccountRepository,
  rateLimiter?: RequestHandler,
  dpop?: DpopEnforcementOptions,
): RequestHandler {
  return async (request, response, next) => {
    try {
      const identity = await sessions.resolve(request.headers);
      if (identity === null) {
        throw new AppError({
          code: "authentication.required",
          title: "Authentication required",
          status: 401,
          detail: "A valid authenticated session is required.",
        });
      }

      // Defensively `typeof === "string"` rather than `!== null`: an
      // AuthenticatedIdentity built by anything looser than a strict
      // SessionResolver implementation (a test double, say) could leave
      // dpopJkt as undefined rather than null, and undefined must still
      // mean unbound, not accidentally trip full DPoP enforcement.
      if (typeof identity.dpopJkt === "string") {
        await enforceBoundSessionProof(request, response, identity.dpopJkt, dpop);
      } else {
        await maybeBindUnboundSession(request, response, sessions, identity, dpop);
      }

      const account = await accounts.findByBetterAuthUserId(identity.betterAuthUserId);
      if (account === null) {
        throw new AppError({
          code: "account.mapping_missing",
          title: "Account unavailable",
          status: 500,
          detail: "The authenticated identity is not linked to a VistaBlox account.",
        });
      }
      if (account.status !== "active") {
        throw new AppError({
          code: "account.restricted",
          title: "Account restricted",
          status: 403,
          detail: "This account is currently restricted from product actions.",
        });
      }

      response.locals.authContext = {
        accountId: account.accountId,
        providerSessionId: identity.providerSessionId,
        population: identity.population,
      };

      // Session time limits (contract 3.6/3.7): the request counts as
      // activity only once it has passed the DPoP proof, the account checks
      // and the rate limiter. A 429 is not activity. If the activity write
      // itself fails, the request still goes through: a missing write can
      // only make the session idle out sooner, never extend it.
      const recordActivityThenContinue = (): void => {
        (sessions.recordActivity?.(identity) ?? Promise.resolve()).then(
          () => next(),
          (activityError: unknown) => {
            response.locals.logger?.warn?.(
              { err: activityError },
              "session activity update failed; continuing without it",
            );
            next();
          },
        );
      };
      if (rateLimiter === undefined) {
        recordActivityThenContinue();
      } else {
        rateLimiter(request, response, (limiterError?: unknown) => {
          if (limiterError !== undefined && limiterError !== null) {
            next(limiterError);
            return;
          }
          recordActivityThenContinue();
        });
      }
    } catch (error) {
      next(error);
    }
  };
}

function readDpopHeader(request: Parameters<RequestHandler>[0]): string | undefined {
  const value = request.headers.dpop;
  return Array.isArray(value) ? undefined : value;
}

function readBearerToken(request: Parameters<RequestHandler>[0]): string | undefined {
  const bearerHeader = request.headers.authorization;
  // Exact characters after "Bearer " -- no trim, ath is defined over what
  // was literally sent, not a normalized form of it.
  return typeof bearerHeader === "string" && bearerHeader.slice(0, 7).toLowerCase() === "bearer "
    ? bearerHeader.slice(7)
    : undefined;
}

function throwDpop401(
  request: Parameters<RequestHandler>[0],
  response: Parameters<RequestHandler>[1],
  dpop: DpopEnforcementOptions | undefined,
  error: Parameters<typeof dpopErrorResponseFields>[0],
): never {
  response.setHeader("WWW-Authenticate", DPOP_WWW_AUTHENTICATE);
  const { code, title, detail } = dpopErrorResponseFields(error);
  dpop?.logger?.rejected({ code, path: request.path });
  throw new AppError({ code, title, status: 401, detail });
}

/** Bound session: a fresh, matching, unreplayed proof is mandatory. */
async function enforceBoundSessionProof(
  request: Parameters<RequestHandler>[0],
  response: Parameters<RequestHandler>[1],
  boundJkt: string,
  dpop: DpopEnforcementOptions | undefined,
): Promise<void> {
  try {
    if (dpop === undefined) {
      // A bound session reached this middleware without DPoP enforcement
      // wired up -- fail closed rather than silently skip the check that
      // makes the session's binding mean anything.
      throw new DpopProofMissingError();
    }

    const claims = await verifyDpopProof({
      header: readDpopHeader(request),
      method: request.method,
      url: buildHtu(dpop.baseUrl, request.originalUrl),
      bearerToken: readBearerToken(request),
    });

    if (claims.jkt !== boundJkt) {
      throw new DpopKeyMismatchError();
    }

    const accepted = await recordProof(dpop, claims);
    if (!accepted) {
      throw new DpopReplayError();
    }
  } catch (error) {
    if (isDpopVerificationError(error)) {
      throwDpop401(request, response, dpop, error);
    }
    throw error;
  }
}

/**
 * Unbound session: Phase 1 never requires a proof here. If one is present
 * and verifies, either bind opportunistically (a session old enough to
 * predate phase 1 shipping) or refuse (a session created after phase 1
 * shipped has no business being unbound -- that combination is an anomaly,
 * not a migration case, and DPOP_KEY_MISMATCH is what tells the client to
 * discard its token and re-authenticate).
 */
async function maybeBindUnboundSession(
  request: Parameters<RequestHandler>[0],
  response: Parameters<RequestHandler>[1],
  sessions: SessionResolver,
  identity: AuthenticatedIdentity,
  dpop: DpopEnforcementOptions | undefined,
): Promise<void> {
  if (dpop === undefined) return;

  const header = readDpopHeader(request);
  if (header === undefined) return;

  let claims: DpopProofClaims;
  try {
    claims = await verifyDpopProof({
      header,
      method: request.method,
      url: buildHtu(dpop.baseUrl, request.originalUrl),
      bearerToken: readBearerToken(request),
    });
  } catch {
    // Can't verify -- best effort, not evidence of anything on its own.
    return;
  }

  const isPreCutover =
    dpop.phase1CutoverAt === undefined || identity.sessionCreatedAt < dpop.phase1CutoverAt;
  if (!isPreCutover) {
    throwDpop401(request, response, dpop, new DpopKeyMismatchError());
  }

  const accepted = await recordProof(dpop, claims);
  if (!accepted) return; // replayed -- best effort, don't bind

  await sessions.bindDpopKey?.(identity.providerSessionId, claims.jkt);
  dpop.logger?.bound({ sessionId: identity.providerSessionId, jkt: claims.jkt });
}

function recordProof(dpop: DpopEnforcementOptions, claims: DpopProofClaims): Promise<boolean> {
  const replayWindowSeconds = dpop.replayWindowSeconds ?? 120;
  return dpop.replayRepository.recordProof(
    claims.jkt,
    claims.jti,
    new Date(Date.now() + replayWindowSeconds * 1000),
  );
}

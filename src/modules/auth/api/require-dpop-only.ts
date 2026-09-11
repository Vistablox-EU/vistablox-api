import type { RequestHandler } from "express";

import {
  DPOP_WWW_AUTHENTICATE,
  DpopReplayError,
  buildHtu,
  dpopErrorResponseFields,
  isDpopVerificationError,
  verifyDpopProof,
} from "../application/dpop-proof-verifier.js";
import type { DpopReplayRepository } from "../repository/dpop-replay.repository.js";
import { AppError } from "../../../shared/errors/app-error.js";

export interface RequireDpopOnlyOptions {
  baseUrl: string;
  replayRepository: DpopReplayRepository;
  replayWindowSeconds?: number;
  /**
   * Default true: verify AND record (jkt, jti). Set false for a route
   * where something downstream (a better-auth ceremony reached via
   * auth.api.*, e.g. E2/L2) does its own full verify-and-record of this
   * exact same request's proof moments later -- recording it here too
   * would make that second, independent record attempt always lose as a
   * replay of this one (both use the same DpopReplayRepository instance).
   * The WeakMap-based single-flight cache that coordinates this
   * elsewhere (dpop-session-creation.ts) can't help across this boundary:
   * the router builds a *new* Request object for the ceremony
   * (requestForDpopBinding, so DPoP's htu binds to this /v1 URL rather
   * than better-auth's internal mount path), so the ceremony never sees
   * this middleware's Request object to find a cached entry on it. This
   * middleware still verifies (and still sets response.locals.dpopJkt) --
   * only the recordProof call is skipped.
   */
  recordReplays?: boolean;
}

/**
 * DPoP-only enforcement for the handful of `/v1` endpoints the contract
 * marks "none (DPoP only)" -- C1, E1, L1, E2, L2 -- where there's no
 * session yet to resolve (E2/L2 do reach a pending/new session, but only
 * *after* their own ceremony's explicit DPoP check, not via this
 * middleware). Records (jkt, jti) the same way session-bound enforcement
 * (requireAuthentication) does, unless recordReplays is false: a captured,
 * still-valid proof (sniffed, logged, replayed by the same caller) is
 * otherwise reusable for its whole iat window with no other gate at this
 * layer -- E1/L1's own challenge is single-use, but C1 has no challenge
 * behind it at all, and even for E1/L1 this is the only thing stopping the
 * *same* proof from being resubmitted to mint a second challenge before
 * the first is consumed.
 */
export function createRequireDpopOnly(options: RequireDpopOnlyOptions): RequestHandler {
  return async (request, response, next) => {
    try {
      // Contract 3.5: "Endpoints whose auth is 'none' ignore an
      // Authorization header if one is present: a stale token is never a
      // reason to fail." Unlike session-bound enforcement, this layer
      // never checks an ath claim against anything -- passing bearerToken
      // here would make a leftover Authorization header (e.g. from a
      // reused HTTP client) spuriously required to match an ath the client
      // never had a reason to include for a DPoP-only call.
      const claims = await verifyDpopProof({
        header: Array.isArray(request.headers.dpop) ? request.headers.dpop[0] : request.headers.dpop,
        method: request.method,
        url: buildHtu(options.baseUrl, request.originalUrl),
        bearerToken: undefined,
      });
      if (options.recordReplays !== false) {
        const accepted = await options.replayRepository.recordProof(
          claims.jkt,
          claims.jti,
          new Date(Date.now() + (options.replayWindowSeconds ?? 120) * 1000),
        );
        if (!accepted) {
          throw new DpopReplayError();
        }
      }
      response.locals.dpopJkt = claims.jkt;
      next();
    } catch (error) {
      if (isDpopVerificationError(error)) {
        const fields = dpopErrorResponseFields(error);
        response.setHeader("WWW-Authenticate", DPOP_WWW_AUTHENTICATE);
        next(
          new AppError({
            code: fields.code,
            title: fields.title,
            status: 401,
            detail: fields.detail,
          }),
        );
        return;
      }
      next(error);
    }
  };
}

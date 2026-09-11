import type { RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import {
  DPOP_WWW_AUTHENTICATE,
  buildHtu,
  dpopErrorResponseFields,
  isDpopVerificationError,
  verifyDpopProof,
} from "../application/dpop-proof-verifier.js";

export interface RequireDpopOnlyOptions {
  baseUrl: string;
}

/**
 * DPoP-only enforcement for the handful of `/v1` endpoints the contract
 * marks "none (DPoP only)" -- C1, E1, L1 -- where there's no session yet to
 * resolve. No replay recording here: the challenge these endpoints hand out
 * is itself single-use (DeviceChallengeRepository), so the DPoP proof's own
 * (jkt, jti) doesn't need a second replay table for this specific path --
 * unlike session-bound enforcement (requireAuthentication), which protects
 * many requests over a session's lifetime and does need one.
 */
export function createRequireDpopOnly(options: RequireDpopOnlyOptions): RequestHandler {
  return async (request, response, next) => {
    try {
      const authHeader = request.headers.authorization;
      const bearerToken =
        typeof authHeader === "string" && authHeader.slice(0, 7).toLowerCase() === "bearer "
          ? authHeader.slice(7)
          : undefined;
      const claims = await verifyDpopProof({
        header: Array.isArray(request.headers.dpop) ? request.headers.dpop[0] : request.headers.dpop,
        method: request.method,
        url: buildHtu(options.baseUrl, request.originalUrl),
        bearerToken,
      });
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

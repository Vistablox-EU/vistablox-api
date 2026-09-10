import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

import {
  DPOP_WWW_AUTHENTICATE,
  buildHtu,
  decideDpopForSession,
  dpopErrorResponseFields,
  isDpopVerificationError,
  type DpopVerificationError,
} from "../application/dpop-proof-verifier.js";
import type { DpopReplayRepository } from "../repository/dpop-replay.repository.js";

export interface BetterAuthDpopPluginOptions {
  baseUrl: string;
  replayRepository: DpopReplayRepository;
  replayWindowSeconds?: number;
  phase1CutoverAt?: Date;
}

/**
 * Enforces device binding on /api/auth/* HTTP calls -- get-session renewal,
 * the passkey generate-*-options calls, sign-in/social, everything the
 * wire contract lists outside the passkey verify-* ceremonies (those are
 * handled inline in better-auth.factory.ts's afterVerification callbacks,
 * since only they need the "pending session" context this plugin doesn't
 * have). Registered after bearer() in the plugins array: bearer turns
 * Authorization into the session cookie context first, so a session is
 * resolvable here at all.
 */
export function createBetterAuthDpopPlugin(options: BetterAuthDpopPluginOptions): BetterAuthPlugin {
  return {
    id: "vistablox-dpop",
    hooks: {
      before: [
        {
          // Internal auth.api.*({ headers }) calls (the session resolver on
          // every /v1 request, the session revoker, the login-method
          // unlinker) carry headers but no request -- there's no method/URL
          // to build htu from, and no reason to enforce here anyway since
          // /v1's own requireAuthentication already covers session-bound
          // enforcement for those.
          matcher: (context) => context.request !== undefined,
          handler: createAuthMiddleware(async (ctx) => {
            const current = await getSessionFromCtx(ctx);
            if (current === null) return;

            const sessionRecord = current.session as Record<string, unknown> & {
              token: string;
              createdAt: Date;
            };
            const boundJkt = sessionRecord.dpopJkt;

            const header = ctx.headers?.get("dpop") ?? undefined;
            const authHeader = ctx.headers?.get("authorization") ?? null;
            const bearerToken =
              authHeader !== null && authHeader.slice(0, 7).toLowerCase() === "bearer "
                ? authHeader.slice(7)
                : undefined;
            const url = buildHtu(options.baseUrl, new URL(ctx.request!.url).pathname);

            try {
              const decision = await decideDpopForSession({
                header,
                method: ctx.request!.method,
                url,
                bearerToken,
                boundJkt: typeof boundJkt === "string" ? boundJkt : null,
                sessionCreatedAt: sessionRecord.createdAt,
                phase1CutoverAt: options.phase1CutoverAt,
                recordProof: (jkt, jti, expiresAt) =>
                  options.replayRepository.recordProof(jkt, jti, expiresAt),
                ...(options.replayWindowSeconds === undefined
                  ? {}
                  : { replayWindowSeconds: options.replayWindowSeconds }),
              });
              if (decision.action === "bind") {
                await ctx.context.internalAdapter.updateSession(sessionRecord.token, {
                  dpopJkt: decision.jkt,
                });
              }
            } catch (error) {
              if (isDpopVerificationError(error)) throw dpopApiError(error);
              throw error;
            }
          }),
        },
      ],
    },
  };
}

function dpopApiError(error: DpopVerificationError): APIError {
  const { code, title, detail } = dpopErrorResponseFields(error);
  return new APIError(
    "UNAUTHORIZED",
    { code, message: `${title}: ${detail}` },
    { "WWW-Authenticate": DPOP_WWW_AUTHENTICATE },
  );
}

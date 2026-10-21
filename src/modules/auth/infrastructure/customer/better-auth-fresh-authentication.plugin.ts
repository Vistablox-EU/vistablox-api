import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

import { isFreshDeviceSession } from "../../domain/fresh-authentication.js";
import { getSessionForHook } from "../shared/better-auth-hook-session.js";

// The /api/auth endpoints that do what /v1's sensitive customer routes do:
// /unlink-account is login-method unlink; /revoke-session, /revoke-sessions
// and /revoke-other-sessions are session revocation. The mobile app calls
// unlink-account here directly, so guarding /v1 alone would leave the door
// the app actually uses open.
const SENSITIVE_PATHS = new Set([
  "/unlink-account",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
]);

export interface BetterAuthFreshAuthenticationPluginOptions {
  clock?: () => Date;
}

/**
 * Requires fresh authentication, the same rule /v1's
 * requireFreshAuthentication applies (domain/fresh-authentication.ts), on the
 * Better Auth endpoints above, for customer sessions.
 *
 * Only HTTP requests are checked. The internal auth.api.*({ headers }) calls
 * made by the /v1 routes (the session revoker, the login-method unlinker)
 * carry headers but no request, and those routes have already enforced the
 * rule in their own middleware, as better-auth-dpop.plugin.ts does for DPoP.
 *
 * The rule has two parts on /v1: the device-biometric window, and a
 * fallback that reads a last-fresh-auth timestamp from the session mirror.
 * No customer factor records that timestamp (only staff passkey logins do),
 * so for a customer the fallback can only answer no, and this hook checks
 * the window alone. If a customer step-up that records one is ever added, this
 * hook has to learn it together with the middleware.
 *
 * Staff and partner sessions are left to their own controls: these are
 * customer self-service actions, as are the /v1 routes this mirrors.
 *
 * The session comes from getSessionForHook for the reason given in
 * better-auth-dpop.plugin.ts: a bearer-only request has no session for a
 * before-hook until bearer()'s cookie is built. No session means an
 * anonymous request, which the endpoint answers itself.
 */
export function createBetterAuthFreshAuthenticationPlugin(
  options: BetterAuthFreshAuthenticationPluginOptions = {},
): BetterAuthPlugin {
  const clock = options.clock ?? (() => new Date());
  return {
    id: "vistablox-fresh-authentication",
    hooks: {
      before: [
        {
          matcher: (context) =>
            context.request !== undefined &&
            context.path !== undefined &&
            SENSITIVE_PATHS.has(context.path),
          handler: createAuthMiddleware(async (ctx) => {
            const current = await getSessionForHook(ctx);
            if (current === null) return;
            const user = current.user as { population?: unknown };
            if (user.population === "staff_partner") return;
            const session = current.session as {
              authenticationLevel?: unknown;
              createdAt: Date;
            };
            const fresh = isFreshDeviceSession(
              {
                population: "customer",
                authenticationLevel:
                  typeof session.authenticationLevel === "string"
                    ? session.authenticationLevel
                    : undefined,
                sessionCreatedAt: session.createdAt,
              },
              clock(),
            );
            if (!fresh) {
              throw APIError.from("FORBIDDEN", {
                code: "FRESH_AUTHENTICATION_REQUIRED",
                message: "Sign in again on this device before continuing.",
              });
            }
          }),
        },
      ],
    },
  };
}

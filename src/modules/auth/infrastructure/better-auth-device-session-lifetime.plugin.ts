import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, setShouldSkipSessionRefresh } from "better-auth/api";

import { evaluateDeviceSessionLifetime } from "../domain/device-session-lifetime.js";

export const DEVICE_SESSION_AUTHENTICATION_LEVEL = "device_biometric";
// Contract 3.6: 401 REAUTH_REQUIRED, "idle or absolute session limit reached".
export const REAUTH_REQUIRED_CODE = "REAUTH_REQUIRED";

export interface BetterAuthDeviceSessionLifetimePluginOptions {
  clock?: () => Date;
}

interface StoredSession {
  token: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  authenticationLevel: unknown;
}

type FindSession = (token: string, ...rest: unknown[]) => Promise<unknown>;

/**
 * Enforces the device-session time limits (contract 3.6/3.7: idle 5 min,
 * absolute 30 min from creation, no silent renewal) on better-auth's own
 * session table. Only sessions with authenticationLevel "device_biometric"
 * are affected; every other session keeps better-auth's normal rolling
 * expiry, exactly as before.
 *
 * `auth_session.updatedAt` is a device session's last-activity time: the
 * factory sets it to `createdAt` at creation, and only
 * BetterAuthSessionResolver.recordActivity moves it (with GREATEST), after a
 * /v1 request has passed its DPoP, account and rate-limit checks.
 *
 * Three pieces:
 *
 * - **Every session lookup.** Every better-auth route that reads a session
 *   (get-session, and every route behind sessionMiddleware or
 *   getSessionFromCtx: list-sessions, revoke-session, update-user,
 *   link-social, ...) goes through `internalAdapter.findSession`. A global
 *   before hook wraps that function once, on the shared adapter object.
 *   (better-auth builds internalAdapter after every plugin's init(), so
 *   init() can't replace it.) For a device session the wrapper:
 *   - tells get-session to skip its silent refresh for this request, so
 *     no refresh write happens at all, and a stale read can't be written
 *     back over newer activity;
 *   - reports a session past either limit as already expired (expiresAt
 *     in the past). better-auth then ends it and treats the request as
 *     unauthenticated, on every route.
 *
 * - **REAUTH_REQUIRED.** An after hook on `/get-session` (the /v1 resolver's
 *   auth.api.getSession call, and better-auth's own /api/auth/get-session)
 *   turns that into REAUTH_REQUIRED instead of an anonymous null. The
 *   expired row is still on `ctx.context.session` there, so the client can
 *   tell "sign in on this device again" apart from "unknown token". Other
 *   routes answer their normal 401.
 *
 * - **Backstop.** `session.update.before` refuses any write of `expiresAt`
 *   to a device session. It is unreachable while the refresh is skipped;
 *   if it is ever reached, the request fails closed instead of extending
 *   the session or rewriting its activity time.
 *
 * The limits are computed from `createdAt` and `updatedAt`, never from
 * `expiresAt`.
 */
export function createBetterAuthDeviceSessionLifetimePlugin(
  options: BetterAuthDeviceSessionLifetimePluginOptions = {},
): BetterAuthPlugin {
  const clock = options.clock ?? (() => new Date());
  const wrappedAdapters = new WeakSet<object>();

  const applyDeviceSessionLimits = async (found: unknown): Promise<unknown> => {
    const current = readSessionRow(found);
    if (current === null || current.authenticationLevel !== DEVICE_SESSION_AUTHENTICATION_LEVEL) {
      return found;
    }
    try {
      await setShouldSkipSessionRefresh(true);
    } catch {
      // Outside a request scope there is no get-session refresh to skip.
    }
    const now = clock();
    const verdict = evaluateDeviceSessionLifetime({
      createdAt: current.createdAt,
      lastActivityAt: current.updatedAt,
      now,
    });
    if (verdict.status === "active") return found;
    const result = found as { session: Record<string, unknown> };
    return {
      ...result,
      session: {
        ...result.session,
        expiresAt: new Date(Math.min(current.expiresAt.getTime(), now.getTime() - 1)),
      },
    };
  };

  const wrapFindSession = (adapter: unknown): void => {
    if (typeof adapter !== "object" || adapter === null || wrappedAdapters.has(adapter)) return;
    const target = adapter as { findSession?: FindSession };
    const original = target.findSession;
    if (typeof original !== "function") return;
    target.findSession = async (token, ...rest) =>
      applyDeviceSessionLimits(await original.call(adapter, token, ...rest));
    wrappedAdapters.add(adapter);
  };

  return {
    id: "vistablox-device-session-lifetime",
    init() {
      return {
        options: {
          databaseHooks: {
            session: {
              update: {
                before: async (data, context) => {
                  if (!("expiresAt" in data)) return;
                  const current = readStoredSession(context);
                  if (current === null || current.authenticationLevel !== DEVICE_SESSION_AUTHENTICATION_LEVEL) {
                    return;
                  }
                  return false;
                },
              },
            },
          },
        },
      };
    },
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            wrapFindSession(ctx.context.internalAdapter);
          }),
        },
      ],
      after: [
        {
          matcher: (context) => context.path === "/get-session",
          handler: createAuthMiddleware(async (ctx) => {
            const current = readStoredSession(ctx);
            if (current === null || current.authenticationLevel !== DEVICE_SESSION_AUTHENTICATION_LEVEL) {
              return;
            }
            const verdict = evaluateDeviceSessionLifetime({
              createdAt: current.createdAt,
              lastActivityAt: current.updatedAt,
              now: clock(),
            });
            // get-session returns null for a session it found but judged
            // expired (and has already deleted it).
            const expiredByBetterAuth =
              ctx.context.returned === null || ctx.context.returned === undefined;
            if (verdict.status === "active" && !expiredByBetterAuth) return;

            // Deleting a row better-auth already removed is a no-op.
            await ctx.context.internalAdapter.deleteSession(current.token);
            throw APIError.from("UNAUTHORIZED", {
              code: REAUTH_REQUIRED_CODE,
              message: "This session reached its time limit. Sign in on this device again.",
            });
          }),
        },
      ],
    },
  };
}

function readStoredSession(context: unknown): StoredSession | null {
  if (typeof context !== "object" || context === null) return null;
  return readSessionRow((context as { context?: { session?: unknown } }).context?.session);
}

/** `found` is findSession's result: `{ session, user }` or null. */
function readSessionRow(found: unknown): StoredSession | null {
  if (typeof found !== "object" || found === null) return null;
  const session = (found as { session?: unknown }).session;
  if (typeof session !== "object" || session === null) return null;

  const row = session as Record<string, unknown>;
  const createdAt = toDate(row.createdAt);
  const updatedAt = toDate(row.updatedAt);
  const expiresAt = toDate(row.expiresAt);
  if (typeof row.token !== "string" || createdAt === null || updatedAt === null || expiresAt === null) {
    return null;
  }
  return {
    token: row.token,
    createdAt,
    updatedAt,
    expiresAt,
    authenticationLevel: row.authenticationLevel,
  };
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

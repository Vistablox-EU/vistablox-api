import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

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

/**
 * Enforces the device-session time limits (contract 3.6/3.7: idle 5 min,
 * absolute 30 min from creation, no silent renewal) on better-auth's own
 * session table. Only sessions with authenticationLevel "device_biometric"
 * are affected; every other session keeps better-auth's normal rolling
 * expiry, exactly as before.
 *
 * `auth_session.updatedAt` is a device session's last-activity time: the
 * factory sets it to `createdAt` at creation, and only
 * BetterAuthSessionResolver.recordActivity moves it, after a /v1 request has
 * passed its DPoP and account checks.
 *
 * Two hooks:
 *
 * - `session.update.before` stops the silent renewal. better-auth's
 *   get-session extends `expiresAt` (and sets `updatedAt`) once a session
 *   is older than `updateAge`. For a device session both fields keep their
 *   stored values, so the absolute limit never moves, and a request that
 *   only resolves the session (and might then fail DPoP) never counts as
 *   activity. get-session sets `ctx.context.session` right before that
 *   update, which is how the hook identifies the row; it is the only
 *   better-auth path that writes `expiresAt` to an existing session.
 *
 * - An after hook on `/get-session` enforces both limits. It runs for the
 *   /v1 resolver's auth.api.getSession call and for better-auth's own
 *   /api/auth/get-session route. A session past either limit is deleted,
 *   and the call fails with REAUTH_REQUIRED instead of returning null, so
 *   the client can tell "sign in on this device again" apart from "this
 *   token is unknown". When better-auth has already expired the row itself
 *   (its `expiresAt` passed), get-session still left the row on
 *   `ctx.context.session`, so that case answers REAUTH_REQUIRED too. The
 *   limits are computed from `createdAt` and `updatedAt`, never from
 *   `expiresAt`, so even a renewal that slipped past the first hook could
 *   not lengthen a session.
 *
 * Hooks that go through getSessionFromCtx (other better-auth routes, such
 * as sign-out) don't run this after hook. The /v1 API never uses those
 * routes for device sessions.
 */
export function createBetterAuthDeviceSessionLifetimePlugin(
  options: BetterAuthDeviceSessionLifetimePluginOptions = {},
): BetterAuthPlugin {
  const clock = options.clock ?? (() => new Date());
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
                  return {
                    data: { ...data, expiresAt: current.expiresAt, updatedAt: current.updatedAt },
                  };
                },
              },
            },
          },
        },
      };
    },
    hooks: {
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
  const found = (context as { context?: { session?: unknown } }).context?.session;
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

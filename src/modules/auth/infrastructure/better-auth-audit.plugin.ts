import { createHmac, randomUUID } from "node:crypto";

import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";

import type { AuthAuditEvent, AuthAuditSink } from "../application/auth-audit-sink.js";
import type { SessionMirror } from "../application/session-mirror.js";
import type { LoginMethodType } from "../../account/repository/account.repository.js";

export interface BetterAuthAuditPluginOptions {
  sink: AuthAuditSink;
  identifierHashKey: string;
  onError?: (error: unknown) => void;
  clock?: () => Date;
  // Optional: mirrors session create/revoke into account.sessions
  // (SESSION_MODEL.md) alongside the audit trail this plugin already writes.
  sessionMirror?: SessionMirror;
  sessionIdleMinutes?: number;
  sessionAbsoluteHours?: number;
  onLoginMethodUsed?: (input: {
    betterAuthUserId: string;
    methodType: LoginMethodType;
    occurredAt: Date;
  }) => Promise<void>;
}

interface AuditContext {
  path?: string | undefined;
  headers?: Headers | undefined;
  body?: unknown;
  params?: unknown;
}

export function createBetterAuthAuditPlugin(
  options: BetterAuthAuditPluginOptions,
): BetterAuthPlugin {
  const clock = options.clock ?? (() => new Date());
  const idleMinutes = options.sessionIdleMinutes ?? 30;
  const absoluteHours = options.sessionAbsoluteHours ?? 12;
  const record = async (event: AuthAuditEvent): Promise<void> => {
    try {
      await options.sink.record(event);
    } catch (error) {
      options.onError?.(error);
    }
  };
  const mirrorCreated = async (
    session: { id: string; userId: string; token: string; createdAt: Date },
    context: AuditContext | null,
    authMethod: string | null,
  ): Promise<void> => {
    if (options.sessionMirror === undefined) return;
    try {
      await options.sessionMirror.recordCreated({
        betterAuthUserId: session.userId,
        betterAuthSessionId: session.id,
        betterAuthSessionToken: session.token,
        authMethodAtLogin: authMethod,
        userAgent: context?.headers?.get("user-agent") ?? null,
        createdAt: session.createdAt,
        idleExpiresAt: new Date(session.createdAt.getTime() + idleMinutes * 60_000),
        absoluteExpiresAt: new Date(session.createdAt.getTime() + absoluteHours * 60 * 60_000),
      });
    } catch (error) {
      options.onError?.(error);
    }
  };
  const mirrorRevoked = async (
    session: { id: string },
    context: AuditContext | null,
  ): Promise<void> => {
    if (options.sessionMirror === undefined) return;
    try {
      await options.sessionMirror.recordRevoked({
        betterAuthSessionId: session.id,
        revokedAt: clock(),
        reason: sessionRevocationReason(context?.path),
      });
    } catch (error) {
      options.onError?.(error);
    }
  };

  return {
    id: "vistablox-auth-audit",
    init() {
      return {
        options: {
          databaseHooks: {
            user: {
              create: {
                after: async (user, context) => {
                  await record({
                    eventKey: `better_auth:identity_created:${user.id}`,
                    action: "authentication.identity_created",
                    betterAuthUserId: user.id,
                    attributeToSubject: true,
                    resourceType: "account",
                    resourceId: user.id,
                    changes: {
                      trace_id: readTraceId(context),
                      authentication_method: resolveLoginMethod(context),
                      population:
                        user.population === "staff_partner" ? "staff_partner" : "customer",
                    },
                    occurredAt: user.createdAt,
                  });
                },
              },
            },
            session: {
              create: {
                after: async (session, context) => {
                  const traceId = readTraceId(context);
                  const method = resolveLoginMethod(context, session);
                  const linkedMethod = resolveLinkedMethod(context);
                  await record({
                    eventKey: `better_auth:session_created:${session.id}`,
                    action: "authentication.session_created",
                    betterAuthUserId: session.userId,
                    attributeToSubject: true,
                    resourceType: "session",
                    resourceId: session.id,
                    changes: {
                      trace_id: traceId,
                      authentication_method: method,
                      source: context?.path ?? "internal",
                    },
                    occurredAt: session.createdAt,
                  });
                  if (isLoginPath(context?.path)) {
                    if (linkedMethod !== null && isSupportedLoginMethod(linkedMethod)) {
                      try {
                        await options.onLoginMethodUsed?.({
                          betterAuthUserId: session.userId,
                          methodType: linkedMethod,
                          occurredAt: session.createdAt,
                        });
                      } catch (error) {
                        options.onError?.(error);
                      }
                    }
                    const oauthPending = isOAuthSignInCompletionPath(context?.path);
                    await record({
                      eventKey: oauthPending
                        ? `better_auth:oauth_verified:${session.id}`
                        : `better_auth:login_succeeded:${session.id}`,
                      action: oauthPending
                        ? "authentication.oauth_verified"
                        : "authentication.login_succeeded",
                      betterAuthUserId: session.userId,
                      attributeToSubject: true,
                      resourceType: "account",
                      resourceId: session.userId,
                      changes: {
                        trace_id: traceId,
                        authentication_method: method,
                        provider_session_id: session.id,
                      },
                      occurredAt: session.createdAt,
                    });
                  }
                  await mirrorCreated(session, context, method);
                },
              },
              delete: {
                after: async (session, context) => {
                  await mirrorRevoked(session, context);
                  await record({
                    eventKey: `better_auth:session_revoked:${session.id}`,
                    action: "authentication.session_revoked",
                    betterAuthUserId: session.userId,
                    attributeToSubject: true,
                    resourceType: "session",
                    resourceId: session.id,
                    changes: {
                      trace_id: readTraceId(context),
                      reason: sessionRevocationReason(context?.path),
                    },
                    occurredAt: clock(),
                  });
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
          matcher: (context) => isLoginPath(context.path),
          handler: createAuthMiddleware(async (context) => {
            if (!isAPIError(context.context.returned)) return;
            try {
              const identity = await resolveFailedIdentity(context, options.identifierHashKey);
              const traceId = readTraceId(context);
              const eventId = readEventId(context);
              await record({
                eventKey: `better_auth:login_failed:${eventId ?? randomUUID()}`,
                action: "authentication.login_failed",
                betterAuthUserId: identity.betterAuthUserId,
                attributeToSubject: false,
                resourceType:
                  identity.betterAuthUserId === null ? "login_attempt" : "account",
                resourceId: identity.resourceId,
                changes: {
                  trace_id: traceId,
                  authentication_method: resolveLoginMethod(context),
                  failure_code: readErrorCode(context.context.returned),
                },
                occurredAt: clock(),
              });
            } catch (error) {
              options.onError?.(error);
            }
          }),
        },
      ],
    },
  };
}

async function resolveFailedIdentity(
  context: unknown,
  hashKey: string,
): Promise<{ betterAuthUserId: string | null; resourceId: string }> {
  const auditContext = context as AuditContext & {
    context: {
      internalAdapter: {
        findUserByEmail(email: string): Promise<{ user: { id: string } } | null>;
      };
    };
  };
  const email = readBodyString(auditContext.body, "email")?.trim().toLowerCase();
  if (email !== null && email !== undefined) {
    const found = await auditContext.context.internalAdapter.findUserByEmail(email);
    if (found !== null) {
      return { betterAuthUserId: found.user.id, resourceId: found.user.id };
    }
    return {
      betterAuthUserId: null,
      resourceId: `login_${createHmac("sha256", hashKey).update(email).digest("hex")}`,
    };
  }
  return { betterAuthUserId: null, resourceId: "login_unknown" };
}

function isLoginPath(path: string | undefined): boolean {
  return (
    path === "/passkey/verify-authentication" ||
    path === "/passkey/verify-registration" ||
    path === "/sign-in/social" ||
    path?.startsWith("/callback/") === true
  );
}

// Mirrors isLoginPath above, minus the passkey paths: "/sign-in/social" also
// counts here for the mobile client's native idToken exchange, which
// better-auth verifies cryptographically before ever creating a session --
// see better-auth.factory.ts's isOAuthSignInCompletionPath for the fuller
// reasoning (duplicated here since this plugin has no shared import for it).
function isOAuthSignInCompletionPath(path: string | undefined): boolean {
  return path === "/sign-in/social" || path?.startsWith("/callback/") === true;
}

function resolveLoginMethod(
  context: AuditContext | null,
  session?: Record<string, unknown>,
): string | null {
  const path = context?.path;
  if (path === "/passkey/verify-authentication" || path === "/passkey/verify-registration") {
    return session?.authenticationLevel === "staff_passkey"
      ? "staff_passkey"
      : "oauth_passkey";
  }
  if (path === "/sign-in/social") return readBodyString(context?.body, "provider");
  if (path?.startsWith("/callback/") === true) {
    return readObjectString(context?.params, "id") ?? path.slice("/callback/".length);
  }
  return null;
}

function resolveLinkedMethod(context: AuditContext | null): string | null {
  const path = context?.path;
  if (path === "/passkey/verify-authentication" || path === "/passkey/verify-registration") {
    return "passkey";
  }
  return resolveLoginMethod(context);
}

function isSupportedLoginMethod(value: string): value is LoginMethodType {
  return value === "passkey" || value === "google" || value === "apple";
}

function sessionRevocationReason(path: string | undefined): string {
  if (path === "/sign-out") return "sign_out";
  if (path === "/revoke-session") return "self_revoke_one";
  if (path === "/revoke-sessions") return "self_revoke_all";
  if (path === "/revoke-other-sessions") return "self_revoke_others";
  if (path === "/get-session") return "expired";
  return "internal";
}

function readTraceId(context: AuditContext | null): string | null {
  return context?.headers?.get("x-trace-id")?.trim() || null;
}

function readEventId(context: AuditContext | null): string | null {
  return context?.headers?.get("x-vistablox-auth-event-id")?.trim() || null;
}

function readBodyString(input: unknown, key: string): string | null {
  return readObjectString(input, key);
}

function readObjectString(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null || !(key in input)) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function readErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("body" in error)) return null;
  return readObjectString((error as { body: unknown }).body, "code");
}

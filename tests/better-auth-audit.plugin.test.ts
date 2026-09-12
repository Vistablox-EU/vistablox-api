import { describe, expect, it, vi } from "vitest";

import type { AuthAuditEvent, AuthAuditSink } from "../src/modules/auth/application/auth-audit-sink.js";
import type { SessionMirror } from "../src/modules/auth/application/session-mirror.js";
import { createBetterAuthAuditPlugin } from "../src/modules/auth/infrastructure/better-auth-audit.plugin.js";

interface AuditDatabaseHooks {
  user: {
    create: { after(user: Record<string, unknown>, context: unknown): Promise<void> };
  };
  session: {
    create: { after(session: Record<string, unknown>, context: unknown): Promise<void> };
    delete: { after(session: Record<string, unknown>, context: unknown): Promise<void> };
  };
}

async function getDatabaseHooks(
  sink: AuthAuditSink,
  onError?: (error: unknown) => void,
  sessionMirror?: SessionMirror,
) {
  const plugin = createBetterAuthAuditPlugin({
    sink,
    identifierHashKey: "test-audit-identifier-key",
    clock: () => new Date("2026-08-31T19:30:00.000Z"),
    ...(onError === undefined ? {} : { onError }),
    ...(sessionMirror === undefined ? {} : { sessionMirror }),
  });
  const initialized = await plugin.init?.({} as never);
  return (initialized as { options: { databaseHooks: AuditDatabaseHooks } }).options
    .databaseHooks;
}

describe("Better Auth audit plugin", () => {
  it("emits deterministic session, passkey login, and revocation event keys", async () => {
    const events = new Map<string, AuthAuditEvent>();
    const sink: AuthAuditSink = {
      record: vi.fn(async (event) => {
        events.set(event.eventKey, event);
      }),
    };
    const hooks = await getDatabaseHooks(sink);
    const headers = new Headers({
      "x-trace-id": "trace_auth",
      "x-vistablox-auth-event-id": "auth_evt_request",
    });
    const session = {
      id: "session_01",
      userId: "auth_user_01",
      createdAt: new Date("2026-08-31T19:29:00.000Z"),
    };

    await hooks.user.create.after(
      {
        id: "auth_user_01",
        createdAt: new Date("2026-08-31T19:28:00.000Z"),
        population: "customer",
        email: "secret@example.test",
      },
      { path: "/callback/google", headers },
    );
    await hooks.session.create.after(session, {
      path: "/passkey/verify-authentication",
      headers,
      body: { response: { id: "credential_01" } },
    });
    await hooks.session.create.after(session, {
      path: "/passkey/verify-authentication",
      headers,
      body: { response: { id: "credential_01" } },
    });
    await hooks.session.delete.after(session, { path: "/sign-out", headers });
    expect([...events.keys()]).toEqual([
      "better_auth:identity_created:auth_user_01",
      "better_auth:session_created:session_01",
      "better_auth:login_succeeded:session_01",
      "better_auth:session_revoked:session_01",
    ]);
    expect(JSON.stringify([...events.values()])).not.toContain("secret@example.test");
    expect(events.get("better_auth:session_revoked:session_01")?.changes.reason).toBe(
      "sign_out",
    );
  });

  it("mirrors session creation and revocation when a sessionMirror is configured", async () => {
    const sessionMirror: SessionMirror = {
      recordCreated: vi.fn().mockResolvedValue(undefined),
      recordRevoked: vi.fn().mockResolvedValue(undefined),
    };
    const sink: AuthAuditSink = { record: vi.fn().mockResolvedValue(undefined) };
    const hooks = await getDatabaseHooks(sink, undefined, sessionMirror);
    const headers = new Headers({ "user-agent": "TestAgent/1.0" });
    const session = {
      id: "session_01",
      userId: "auth_user_01",
      token: "tok_abc123",
      createdAt: new Date("2026-08-31T19:29:00.000Z"),
    };

    await hooks.session.create.after(session, { path: "/passkey/verify-authentication", headers });
    await hooks.session.delete.after(session, { path: "/revoke-session", headers });

    expect(sessionMirror.recordCreated).toHaveBeenCalledWith({
      betterAuthUserId: "auth_user_01",
      betterAuthSessionId: "session_01",
      channel: "web",
      authMethodAtLogin: "oauth_passkey",
      userAgent: "TestAgent/1.0",
      createdAt: new Date("2026-08-31T19:29:00.000Z"),
      idleExpiresAt: new Date("2026-08-31T19:59:00.000Z"),
      absoluteExpiresAt: new Date("2026-09-01T07:29:00.000Z"),
    });
    expect(sessionMirror.recordRevoked).toHaveBeenCalledWith({
      betterAuthSessionId: "session_01",
      revokedAt: new Date("2026-08-31T19:30:00.000Z"),
      reason: "self_revoke_one",
    });
  });

  it("does not fail the session hooks when the sessionMirror throws", async () => {
    const onError = vi.fn();
    const sessionMirror: SessionMirror = {
      recordCreated: vi.fn().mockRejectedValue(new Error("mirror unavailable")),
      recordRevoked: vi.fn().mockResolvedValue(undefined),
    };
    const sink: AuthAuditSink = { record: vi.fn().mockResolvedValue(undefined) };
    const hooks = await getDatabaseHooks(sink, onError, sessionMirror);

    await expect(
      hooks.session.create.after(
        {
          id: "session_01",
          userId: "auth_user_01",
          token: "tok_abc123",
          createdAt: new Date("2026-08-31T19:29:00.000Z"),
        },
        { path: "/callback/google", headers: new Headers() },
      ),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(new Error("mirror unavailable"));
  });

  it("reports audit persistence failures without failing authentication hooks", async () => {
    const persistenceError = new Error("audit database unavailable");
    const onError = vi.fn();
    const hooks = await getDatabaseHooks(
      { record: vi.fn().mockRejectedValue(persistenceError) },
      onError,
    );

    await expect(
      hooks.session.create.after(
        {
          id: "session_01",
          userId: "auth_user_01",
          createdAt: new Date("2026-08-31T19:29:00.000Z"),
        },
        { path: "/callback/apple", headers: new Headers() },
      ),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(persistenceError);
  });
});

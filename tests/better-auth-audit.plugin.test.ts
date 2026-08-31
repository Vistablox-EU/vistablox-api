import { describe, expect, it, vi } from "vitest";

import type { AuthAuditEvent, AuthAuditSink } from "../src/modules/auth/application/auth-audit-sink.js";
import { createBetterAuthAuditPlugin } from "../src/modules/auth/infrastructure/better-auth-audit.plugin.js";

interface AuditDatabaseHooks {
  user: {
    create: { after(user: Record<string, unknown>, context: unknown): Promise<void> };
  };
  session: {
    create: { after(session: Record<string, unknown>, context: unknown): Promise<void> };
    delete: { after(session: Record<string, unknown>, context: unknown): Promise<void> };
  };
  account: {
    update: { after(account: Record<string, unknown>, context: unknown): Promise<void> };
  };
}

async function getDatabaseHooks(sink: AuthAuditSink, onError?: (error: unknown) => void) {
  const plugin = createBetterAuthAuditPlugin({
    sink,
    identifierHashKey: "test-audit-identifier-key",
    clock: () => new Date("2026-08-31T19:30:00.000Z"),
    ...(onError === undefined ? {} : { onError }),
  });
  const initialized = await plugin.init?.({} as never);
  return (initialized as { options: { databaseHooks: AuditDatabaseHooks } }).options
    .databaseHooks;
}

describe("Better Auth audit plugin", () => {
  it("emits deterministic session, login, revocation, and password event keys", async () => {
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
      { path: "/sign-up/email", headers },
    );
    await hooks.session.create.after(session, {
      path: "/sign-in/email",
      headers,
      body: { email: "secret@example.test", password: "never-audited" },
    });
    await hooks.session.create.after(session, {
      path: "/sign-in/email",
      headers,
      body: { email: "secret@example.test", password: "never-audited" },
    });
    await hooks.session.delete.after(session, { path: "/sign-out", headers });
    await hooks.account.update.after(
      {
        id: "credential_01",
        userId: "auth_user_01",
        providerId: "credential",
        updatedAt: new Date("2026-08-31T19:29:30.000Z"),
        password: "never-audited-hash",
      },
      { path: "/change-password", headers },
    );

    expect([...events.keys()]).toEqual([
      "better_auth:identity_created:auth_user_01",
      "better_auth:session_created:session_01",
      "better_auth:login_succeeded:session_01",
      "better_auth:session_revoked:session_01",
      "better_auth:password_changed:credential_01:auth_evt_request",
    ]);
    expect(JSON.stringify([...events.values()])).not.toContain("secret@example.test");
    expect(JSON.stringify([...events.values()])).not.toContain("never-audited");
    expect(events.get("better_auth:session_revoked:session_01")?.changes.reason).toBe(
      "sign_out",
    );
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
        { path: "/sign-in/email", headers: new Headers() },
      ),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(persistenceError);
  });
});

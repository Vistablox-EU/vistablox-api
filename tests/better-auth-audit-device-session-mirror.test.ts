import { describe, expect, it, vi } from "vitest";

import type { AuthAuditSink } from "../src/modules/auth/application/auth-audit-sink.js";
import type { SessionMirror } from "../src/modules/auth/application/session-mirror.js";
import { createBetterAuthAuditPlugin } from "../src/modules/auth/infrastructure/better-auth-audit.plugin.js";

interface SessionCreateHook {
  session: { create: { after(session: Record<string, unknown>, context: unknown): Promise<void> } };
}

async function sessionCreateAfter(sessionMirror: SessionMirror) {
  const sink: AuthAuditSink = { record: vi.fn().mockResolvedValue(undefined) };
  const plugin = createBetterAuthAuditPlugin({
    sink,
    identifierHashKey: "test-audit-identifier-key",
    sessionMirror,
  });
  const initialized = await plugin.init?.({} as never);
  return (initialized as { options: { databaseHooks: SessionCreateHook } }).options.databaseHooks
    .session.create.after;
}

describe("audit plugin session mirror: device session limits", () => {
  const createdAt = new Date("2026-09-11T12:00:00.000Z");

  it("mirrors a device_biometric session with idle 5 min and absolute 30 min", async () => {
    const sessionMirror: SessionMirror = {
      recordCreated: vi.fn().mockResolvedValue(undefined),
      recordRevoked: vi.fn(),
    };
    const after = await sessionCreateAfter(sessionMirror);

    await after(
      { id: "session_01", userId: "auth_user_01", token: "tok", createdAt, authenticationLevel: "device_biometric" },
      { path: "/device/login/verify", headers: new Headers() },
    );

    expect(sessionMirror.recordCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        idleExpiresAt: new Date("2026-09-11T12:05:00.000Z"),
        absoluteExpiresAt: new Date("2026-09-11T12:30:00.000Z"),
      }),
    );
  });

  it("keeps every other session on the web policy (idle 30 min, absolute 12 h)", async () => {
    const sessionMirror: SessionMirror = {
      recordCreated: vi.fn().mockResolvedValue(undefined),
      recordRevoked: vi.fn(),
    };
    const after = await sessionCreateAfter(sessionMirror);

    await after(
      { id: "session_02", userId: "auth_user_01", token: "tok2", createdAt, authenticationLevel: "staff_passkey" },
      { path: "/passkey/verify-authentication", headers: new Headers() },
    );

    expect(sessionMirror.recordCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        idleExpiresAt: new Date("2026-09-11T12:30:00.000Z"),
        absoluteExpiresAt: new Date("2026-09-12T00:00:00.000Z"),
      }),
    );
  });
});

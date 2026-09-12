import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "../src/infrastructure/database/prisma.js";
import { PrismaSessionMirror } from "../src/modules/auth/infrastructure/prisma-session-mirror.js";

function buildMirror() {
  const accountFindUnique = vi.fn().mockResolvedValue({ id: "acct_01" });
  const sessionCreate = vi.fn().mockResolvedValue(undefined);
  const sessionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const database = {
    account: { findUnique: accountFindUnique },
    session: { create: sessionCreate, updateMany: sessionUpdateMany },
  } as unknown as DatabaseClient;

  return {
    mirror: new PrismaSessionMirror(database, "test-hash-key"),
    sessionCreate,
    sessionUpdateMany,
  };
}

describe("PrismaSessionMirror", () => {
  it("persists the channel derived from the authenticated Better Auth session", async () => {
    const { mirror, sessionCreate } = buildMirror();

    await mirror.recordCreated({
      betterAuthUserId: "auth_user_01",
      betterAuthSessionId: "provider_session_01",
      channel: "mobile",
      authMethodAtLogin: "device_biometric",
      userAgent: null,
      createdAt: new Date("2026-09-12T12:00:00.000Z"),
      idleExpiresAt: new Date("2026-09-12T12:05:00.000Z"),
      absoluteExpiresAt: new Date("2026-09-12T12:30:00.000Z"),
    });

    expect(sessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ channel: "mobile" }) }),
    );
  });

  it("updates ordinary session activity without changing its idle expiry", async () => {
    const { mirror, sessionUpdateMany } = buildMirror();
    const seenAt = new Date("2026-09-12T12:00:00.000Z");

    await mirror.recordActivity({ betterAuthSessionId: "provider_session_01", seenAt });

    expect(sessionUpdateMany).toHaveBeenCalledWith({
      where: { betterAuthSessionId: "provider_session_01", revokedAt: null },
      data: { lastSeenAt: seenAt },
    });
  });
});

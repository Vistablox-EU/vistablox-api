import { describe, expect, it, vi } from "vitest";

import { BetterAuthSessionResolver } from "../src/modules/auth/infrastructure/better-auth-session.resolver.js";
import { createBetterAuthStaffAccountGuardPlugin } from "../src/modules/auth/infrastructure/better-auth-staff-account-guard.plugin.js";

describe("Better Auth staff account guard", () => {
  it("blocks session creation for a disabled identity", async () => {
    const findUserById = vi.fn().mockResolvedValue({
      id: "auth_staff",
      disabledAt: new Date("2026-08-31T20:00:00.000Z"),
    });
    const before = createBetterAuthStaffAccountGuardPlugin()
      .init()
      .options.databaseHooks.session.create.before;

    await expect(
      before(
        { userId: "auth_staff" },
        { context: { internalAdapter: { findUserById } } },
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "STAFF_ACCOUNT_DISABLED" },
    });
  });

  it("allows session creation for an enabled identity", async () => {
    const findUserById = vi.fn().mockResolvedValue({
      id: "auth_staff",
      disabledAt: null,
      recoveryRequiredAt: null,
    });
    const before = createBetterAuthStaffAccountGuardPlugin()
      .init()
      .options.databaseHooks.session.create.before;

    await expect(
      before(
        { userId: "auth_staff" },
        { context: { internalAdapter: { findUserById } } },
      ),
    ).resolves.toBeUndefined();
  });

  it("blocks sessions while staff recovery is pending", async () => {
    const findUserById = vi.fn().mockResolvedValue({
      id: "auth_staff",
      disabledAt: null,
      recoveryRequiredAt: new Date("2026-08-31T20:00:00.000Z"),
    });
    const hooks = createBetterAuthStaffAccountGuardPlugin().init().options.databaseHooks;
    const context = { context: { internalAdapter: { findUserById } } };

    await expect(
      hooks.session.create.before({ userId: "auth_staff" }, context),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "STAFF_ACCOUNT_RECOVERY_REQUIRED" },
    });
  });

  it("rejects an already-issued session when its identity becomes restricted", async () => {
    const getSession = vi.fn().mockResolvedValue({
      user: {
        id: "auth_staff",
        population: "staff_partner",
        disabledAt: null,
        recoveryRequiredAt: new Date("2026-08-31T20:00:00.000Z"),
      },
      session: { id: "session_existing" },
    });
    const resolver = new BetterAuthSessionResolver({ api: { getSession } } as never);

    await expect(resolver.resolve({ cookie: "vb_session=opaque" })).resolves.toBeNull();
  });
});

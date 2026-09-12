import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it, vi } from "vitest";

import { createBetterAuthStaffAccountGuardPlugin } from "../src/modules/auth/infrastructure/better-auth-staff-account-guard.plugin.js";

// A session created with no request context -- outside any authentication
// endpoint -- is refused. The guard can't see how such a session is being
// created (so it can't enforce staff-only-via-passkey, recovery completion
// or a verified OAuth email), nor look up its user. better-auth passes
// undefined there (tryGetCurrentAuthEndpointContext); null is treated the
// same.
describe("staff account guard: session creation with no request context", () => {
  const before = createBetterAuthStaffAccountGuardPlugin().init().options.databaseHooks.session.create.before;

  it.each([
    ["undefined", undefined],
    ["null", null],
  ] as const)("refuses when the context is %s", async (_label, context) => {
    await expect(before({ userId: "auth_staff" }, context)).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "SESSION_CONTEXT_REQUIRED" },
    });
  });

  it("refuses internalAdapter.createSession outside any endpoint on a real better-auth instance, and writes no session", async () => {
    const db: Record<string, Array<Record<string, unknown>>> = {
      user: [],
      session: [],
      account: [],
      verification: [],
    };
    const auth = betterAuth({
      database: memoryAdapter(db),
      baseURL: "http://localhost:3000",
      secret: "unit-test-secret-that-is-at-least-32-characters-long",
      emailAndPassword: { enabled: false },
      plugins: [createBetterAuthStaffAccountGuardPlugin() as unknown as BetterAuthPlugin],
    });
    const context = await auth.$context;
    const user = await context.internalAdapter.createUser(
      { name: "No Context", email: "no-context@example.test", emailVerified: true },
      { method: "internal" },
    );

    await expect(context.internalAdapter.createSession(user.id)).rejects.toMatchObject({
      body: { code: "SESSION_CONTEXT_REQUIRED" },
    });
    expect(db.session).toHaveLength(0);
  });

  it("still applies the staff checks when a request context is present", async () => {
    const findUserById = vi.fn().mockResolvedValue({
      id: "auth_staff",
      population: "staff_partner",
      emailVerified: true,
      disabledAt: null,
      recoveryRequiredAt: null,
    });

    await expect(
      before(
        { userId: "auth_staff" },
        { path: "/sign-in/social", context: { internalAdapter: { findUserById } } },
      ),
    ).rejects.toMatchObject({ statusCode: 403, body: { code: "STAFF_PASSKEY_REQUIRED" } });
    expect(findUserById).toHaveBeenCalledWith("auth_staff");
  });
});

import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { isDeviceSessionLookupWrapped } from "../src/modules/auth/infrastructure/better-auth-device-session-lifetime.plugin.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";

// The real factory, no database: the pool below is never connected to,
// because building better-auth's context doesn't query the database.
describe("createBetterAuth: device-session limits are in place before the first request", () => {
  it("wraps internalAdapter.findSession as soon as auth.$context resolves, and orders the plugin before the DPoP plugin", async () => {
    const pool = new Pool({ connectionString: "postgresql://unused:unused@127.0.0.1:1/unused" });
    try {
      const auth = createBetterAuth({
        database: pool,
        baseURL: "http://localhost:3000",
        secret: "unit-test-secret-that-is-at-least-32-characters-long",
        secureCookies: false,
        trustedOrigins: ["http://localhost:3000"],
        dpop: {
          baseUrl: "http://localhost:3000",
          replayRepository: { recordProof: vi.fn().mockResolvedValue(true), pruneExpired: vi.fn() },
        },
      });

      const context = await auth.$context;

      expect(isDeviceSessionLookupWrapped(context.internalAdapter)).toBe(true);
      const pluginIds = (context.options.plugins ?? []).map((plugin) => plugin.id);
      const lifetimeIndex = pluginIds.indexOf("vistablox-device-session-lifetime");
      const dpopIndex = pluginIds.findIndex((id) => id.includes("dpop"));
      expect(lifetimeIndex).toBeGreaterThanOrEqual(0);
      expect(dpopIndex).toBeGreaterThan(lifetimeIndex);
    } finally {
      await pool.end();
    }
  });
});

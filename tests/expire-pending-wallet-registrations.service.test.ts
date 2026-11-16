import { describe, expect, it, vi } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";
import { ExpirePendingWalletRegistrationsService } from "../src/modules/wallet/application/expire-pending-wallet-registrations.service.js";

// Pending wallet claims expire after a configurable TTL (#177). The query and
// its audit rows are covered in tests/wallet-claim-expiry.integration.test.ts.
describe("ExpirePendingWalletRegistrationsService", () => {
  it("expires claims requested before now minus the configured hours and reports what it did", async () => {
    const now = new Date("2026-11-16T12:00:00.000Z");
    const expirePendingWalletRegistrations = vi.fn().mockResolvedValue({ checked: 3, expired: 2 });
    const service = new ExpirePendingWalletRegistrationsService({ expirePendingWalletRegistrations }, () => now, 6);

    await expect(service.execute("trace")).resolves.toEqual({ checked: 3, acted: 2 });
    expect(expirePendingWalletRegistrations).toHaveBeenCalledWith({
      cutoff: new Date("2026-11-16T06:00:00.000Z"),
      now,
    });
  });

  it("defaults to a 24-hour lifetime", async () => {
    const now = new Date("2026-11-16T12:00:00.000Z");
    const expirePendingWalletRegistrations = vi.fn().mockResolvedValue({ checked: 0, expired: 0 });

    await new ExpirePendingWalletRegistrationsService({ expirePendingWalletRegistrations }, () => now).execute("trace");

    expect(expirePendingWalletRegistrations).toHaveBeenCalledWith({ cutoff: new Date("2026-11-15T12:00:00.000Z"), now });
  });
});

describe("WALLET_REGISTRY_PENDING_EXPIRE_AFTER_HOURS", () => {
  const base = {
    DATABASE_URL: "postgresql://user:password@localhost:5432/vistablox",
    BETTER_AUTH_SECRET: "a-secure-test-secret-that-is-long-enough",
    SMTP_HOST: "smtp.example.com",
    SMTP_USER: "user",
    SMTP_PASSWORD: "password",
    SMTP_FROM: "no-reply@example.com",
    DIDIT_API_KEY: "key",
    DIDIT_WORKFLOW_ID: "269214fe-77f7-4b1a-a028-b70e861d73c1",
    DIDIT_CALLBACK_URL: "https://app.vistablox.io/kyc/complete",
    DIDIT_WEBHOOK_SECRET: "a-didit-webhook-secret-value-32-chars",
    DIDIT_APPLICATION_ID: "c2237bc6-a76c-4933-b329-6c81843b45c7",
    DIDIT_ENVIRONMENT: "sandbox",
  };
  const name = "WALLET_REGISTRY_PENDING_EXPIRE_AFTER_HOURS";

  it("defaults to 24 hours, also when the compose file passes it blank", () => {
    expect(loadEnvironment(base)[name]).toBe(24);
    expect(loadEnvironment({ ...base, [name]: "" })[name]).toBe(24);
  });

  it("accepts 1 to 720 hours and refuses anything else", () => {
    expect(loadEnvironment({ ...base, [name]: "1" })[name]).toBe(1);
    expect(loadEnvironment({ ...base, [name]: "720" })[name]).toBe(720);
    for (const bad of ["0", "721", "2.5", "abc", "-1"]) {
      expect(() => loadEnvironment({ ...base, [name]: bad })).toThrow();
    }
  });
});

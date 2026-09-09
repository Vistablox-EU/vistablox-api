import { describe, expect, it } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";

const base = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/vistablox",
  BETTER_AUTH_SECRET: "a-secure-development-secret-value",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "user",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "VistaBlox <no-reply@example.com>",
  KYC_SERVICE_URL: "http://vistablox-kyc:3000",
  INTERNAL_KYC_API_SECRET: "an-internal-kyc-api-secret-value-32-chars",
};

describe("Didit environment configuration", () => {
  it("allows account recovery's Didit usage to remain disabled", () => {
    expect(loadEnvironment(base).DIDIT_API_KEY).toBeUndefined();
  });

  it("requires the complete Didit configuration when enabled", () => {
    expect(() => loadEnvironment({ ...base, DIDIT_API_KEY: "key" })).toThrow(
      "All Didit account-recovery settings must be configured together",
    );
  });

  it("loads a complete configuration", () => {
    const result = loadEnvironment({
      ...base,
      DIDIT_API_KEY: "key",
      DIDIT_WORKFLOW_ID: "269214fe-77f7-4b1a-a028-b70e861d73c1",
      DIDIT_CALLBACK_URL: "https://app.vistablox.io/kyc/complete",
    });

    expect(result.DIDIT_API_BASE_URL).toBe("https://verification.didit.me");
    expect(result.DIDIT_CALLBACK_URL).toBe("https://app.vistablox.io/kyc/complete");
  });

  it("accepts only Redis-compatible protected profile cache URLs", () => {
    expect(
      loadEnvironment({ ...base, PROFILE_CACHE_URL: "rediss://cache.example.test:6380" })
        .PROFILE_CACHE_URL,
    ).toBe("rediss://cache.example.test:6380");
    expect(() =>
      loadEnvironment({ ...base, PROFILE_CACHE_URL: "https://cache.example.test" }),
    ).toThrow("PROFILE_CACHE_URL must be a Redis or TLS Redis URL");
  });
});

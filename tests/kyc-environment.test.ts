import { describe, expect, it } from "vitest";

import { loadKycEnvironment } from "../src/config/kyc-environment.js";

const base = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/vistablox",
  DIDIT_API_KEY: "key",
  DIDIT_WORKFLOW_ID: "269214fe-77f7-4b1a-a028-b70e861d73c1",
  DIDIT_CALLBACK_URL: "https://app.vistablox.io/kyc/complete",
  DIDIT_WEBHOOK_SECRET: "didit-webhook-secret-for-test",
  DIDIT_APPLICATION_ID: "c5f501a8-0a32-42cd-ac24-13d0d0b15699",
  DIDIT_ENVIRONMENT: "sandbox",
  INTERNAL_KYC_API_SECRET: "an-internal-kyc-api-secret-value-32-chars",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "user",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "VistaBlox <no-reply@example.com>",
};

describe("KYC service environment configuration", () => {
  it("loads a complete configuration with defaults applied", () => {
    const result = loadKycEnvironment(base);
    expect(result.DIDIT_API_BASE_URL).toBe("https://verification.didit.me");
    expect(result.PORT).toBe(3_000);
    expect(result.DIDIT_POA_WORKFLOW_ID).toBeUndefined();
    expect(result.PROFILE_CACHE_URL).toBeUndefined();
    expect(result.SMTP_PORT).toBe(587);
    expect(result.SMTP_SECURE).toBe(false);
  });

  it.each([
    "DATABASE_URL",
    "DIDIT_API_KEY",
    "DIDIT_WORKFLOW_ID",
    "DIDIT_CALLBACK_URL",
    "DIDIT_WEBHOOK_SECRET",
    "DIDIT_APPLICATION_ID",
    "DIDIT_ENVIRONMENT",
    "INTERNAL_KYC_API_SECRET",
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
  ] as const)("requires %s outright -- there is no disabled mode for this service", (key) => {
    const withoutKey: Record<string, string | undefined> = { ...base };
    delete withoutKey[key];
    expect(() => loadKycEnvironment(withoutKey)).toThrow();
  });

  it("accepts an optional, distinct proof-of-address workflow", () => {
    const result = loadKycEnvironment({
      ...base,
      DIDIT_POA_WORKFLOW_ID: "bb17fe44-5b38-48f3-acb7-39dbc38c9317",
    });
    expect(result.DIDIT_POA_WORKFLOW_ID).toBe("bb17fe44-5b38-48f3-acb7-39dbc38c9317");
  });

  it("rejects a proof-of-address workflow identical to the baseline one", () => {
    expect(() =>
      loadKycEnvironment({
        ...base,
        DIDIT_POA_WORKFLOW_ID: base.DIDIT_WORKFLOW_ID,
      }),
    ).toThrow("DIDIT_POA_WORKFLOW_ID must differ from DIDIT_WORKFLOW_ID");
  });

  it("accepts only Redis-compatible protected profile cache URLs", () => {
    expect(
      loadKycEnvironment({ ...base, PROFILE_CACHE_URL: "rediss://cache.example.test:6380" })
        .PROFILE_CACHE_URL,
    ).toBe("rediss://cache.example.test:6380");
    expect(() =>
      loadKycEnvironment({ ...base, PROFILE_CACHE_URL: "https://cache.example.test" }),
    ).toThrow("PROFILE_CACHE_URL must be a Redis or TLS Redis URL");
  });
});

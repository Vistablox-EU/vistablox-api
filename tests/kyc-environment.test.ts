import { describe, expect, it } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";

const base = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/vistablox",
  BETTER_AUTH_SECRET: "a-secure-development-secret-value",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "user",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "VistaBlox <no-reply@example.com>",
  OIDC_JWKS: JSON.stringify({ keys: [{ kty: "oct", k: "test-key", kid: "test" }] }),
  OIDC_NATIVE_REDIRECT_URIS: "com.vistablox.app:/oauth/callback",
};

describe("Didit environment configuration", () => {
  it("allows KYC to remain disabled", () => {
    expect(loadEnvironment(base).DIDIT_API_KEY).toBeUndefined();
  });

  it("requires the complete Didit configuration when enabled", () => {
    expect(() => loadEnvironment({ ...base, DIDIT_API_KEY: "key" })).toThrow(
      "All Didit KYC settings must be configured together",
    );
  });

  it("loads a complete sandbox configuration", () => {
    const result = loadEnvironment({
      ...base,
      DIDIT_API_KEY: "key",
      DIDIT_WORKFLOW_ID: "269214fe-77f7-4b1a-a028-b70e861d73c1",
      DIDIT_POA_WORKFLOW_ID: "bb17fe44-5b38-48f3-acb7-39dbc38c9317",
      DIDIT_CALLBACK_URL: "https://app.vistablox.io/kyc/complete",
      DIDIT_WEBHOOK_SECRET: "didit-webhook-secret-for-test",
      DIDIT_APPLICATION_ID: "c5f501a8-0a32-42cd-ac24-13d0d0b15699",
      DIDIT_ENVIRONMENT: "sandbox",
    });

    expect(result.DIDIT_API_BASE_URL).toBe("https://verification.didit.me");
    expect(result.DIDIT_ENVIRONMENT).toBe("sandbox");
    expect(result.DIDIT_POA_WORKFLOW_ID).toBe(
      "bb17fe44-5b38-48f3-acb7-39dbc38c9317",
    );
  });

  it("rejects a POA workflow without a distinct baseline integration", () => {
    expect(() =>
      loadEnvironment({
        ...base,
        DIDIT_POA_WORKFLOW_ID: "bb17fe44-5b38-48f3-acb7-39dbc38c9317",
      }),
    ).toThrow("DIDIT_POA_WORKFLOW_ID requires the Didit KYC integration");
    expect(() =>
      loadEnvironment({
        ...base,
        DIDIT_API_KEY: "key",
        DIDIT_WORKFLOW_ID: "269214fe-77f7-4b1a-a028-b70e861d73c1",
        DIDIT_POA_WORKFLOW_ID: "269214fe-77f7-4b1a-a028-b70e861d73c1",
        DIDIT_CALLBACK_URL: "https://app.vistablox.io/kyc/complete",
        DIDIT_WEBHOOK_SECRET: "didit-webhook-secret-for-test",
        DIDIT_APPLICATION_ID: "c5f501a8-0a32-42cd-ac24-13d0d0b15699",
        DIDIT_ENVIRONMENT: "sandbox",
      }),
    ).toThrow("DIDIT_POA_WORKFLOW_ID must differ from DIDIT_WORKFLOW_ID");
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

import { describe, expect, it } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";

const base = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/vistablox",
  BETTER_AUTH_SECRET: "a-secure-development-secret-value",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "user",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "VistaBlox <no-reply@example.com>",
  DIDIT_API_KEY: "key",
  DIDIT_WORKFLOW_ID: "269214fe-77f7-4b1a-a028-b70e861d73c1",
  DIDIT_CALLBACK_URL: "https://app.vistablox.io/kyc/complete",
  DIDIT_WEBHOOK_SECRET: "a-didit-webhook-secret-value-32-chars",
  DIDIT_APPLICATION_ID: "c2237bc6-a76c-4933-b329-6c81843b45c7",
  DIDIT_ENVIRONMENT: "sandbox",
};

describe("Didit environment configuration", () => {
  it("loads a complete configuration", () => {
    const result = loadEnvironment(base);

    expect(result.DIDIT_API_BASE_URL).toBe("https://verification.didit.me");
    expect(result.DIDIT_CALLBACK_URL).toBe("https://app.vistablox.io/kyc/complete");
    expect(result.DIDIT_POA_WORKFLOW_ID).toBeUndefined();
  });

  it("requires DIDIT_API_KEY -- there is no disabled mode any more", () => {
    const { DIDIT_API_KEY: _omit, ...rest } = base;
    expect(() => loadEnvironment(rest)).toThrow();
  });

  it("requires DIDIT_WORKFLOW_ID to be a UUID", () => {
    expect(() => loadEnvironment({ ...base, DIDIT_WORKFLOW_ID: "not-a-uuid" })).toThrow();
  });

  it("requires DIDIT_ENVIRONMENT to be sandbox or live", () => {
    expect(() => loadEnvironment({ ...base, DIDIT_ENVIRONMENT: "prod" })).toThrow();
  });

  it("accepts an optional DIDIT_POA_WORKFLOW_ID that differs from the baseline workflow", () => {
    const result = loadEnvironment({
      ...base,
      DIDIT_POA_WORKFLOW_ID: "bb17fe44-5b38-48f3-acb7-39dbc38c9317",
    });

    expect(result.DIDIT_POA_WORKFLOW_ID).toBe("bb17fe44-5b38-48f3-acb7-39dbc38c9317");
  });

  it("rejects a DIDIT_POA_WORKFLOW_ID identical to DIDIT_WORKFLOW_ID", () => {
    expect(() =>
      loadEnvironment({ ...base, DIDIT_POA_WORKFLOW_ID: base.DIDIT_WORKFLOW_ID }),
    ).toThrow("DIDIT_POA_WORKFLOW_ID must differ from DIDIT_WORKFLOW_ID");
  });

  it("accepts only Redis-compatible protected profile cache URLs", () => {
    expect(loadEnvironment(base).PROFILE_CACHE_URL).toBeUndefined();
    expect(
      loadEnvironment({ ...base, PROFILE_CACHE_URL: "redis://cache:6379" }).PROFILE_CACHE_URL,
    ).toBe("redis://cache:6379");
    expect(
      loadEnvironment({ ...base, PROFILE_CACHE_URL: "rediss://cache.example.test:6380" })
        .PROFILE_CACHE_URL,
    ).toBe("rediss://cache.example.test:6380");
    expect(() => loadEnvironment({ ...base, PROFILE_CACHE_URL: "http://cache:6379" })).toThrow(
      "PROFILE_CACHE_URL must be a Redis or TLS Redis URL",
    );
  });
});

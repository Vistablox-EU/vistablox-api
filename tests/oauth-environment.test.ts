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

describe("customer OAuth environment configuration", () => {
  it("keeps both providers disabled by default", () => {
    const environment = loadEnvironment(base);
    expect(environment.GOOGLE_OAUTH_ENABLED).toBe(false);
    expect(environment.APPLE_OAUTH_ENABLED).toBe(false);
  });

  it("requires Google credentials when Google is enabled", () => {
    expect(() => loadEnvironment({ ...base, GOOGLE_OAUTH_ENABLED: "true" }))
      .toThrow("Google OAuth credentials are required");
  });

  it("requires the complete Apple credential set when Apple is enabled", () => {
    expect(() =>
      loadEnvironment({
        ...base,
        APPLE_OAUTH_ENABLED: "true",
        APPLE_CLIENT_ID: "com.vistablox.web",
      }),
    ).toThrow("All Apple OAuth settings must be configured together");
  });

  it("accepts independently enabled providers", () => {
    const google = loadEnvironment({
      ...base,
      GOOGLE_OAUTH_ENABLED: "true",
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
    });
    const apple = loadEnvironment({
      ...base,
      APPLE_OAUTH_ENABLED: "true",
      APPLE_CLIENT_ID: "com.vistablox.web",
      APPLE_TEAM_ID: "TEAM123",
      APPLE_KEY_ID: "KEY123",
      APPLE_PRIVATE_KEY: "private-key-placeholder",
    });

    expect(google.GOOGLE_OAUTH_ENABLED).toBe(true);
    expect(google.APPLE_OAUTH_ENABLED).toBe(false);
    expect(apple.APPLE_OAUTH_ENABLED).toBe(true);
    expect(apple.GOOGLE_OAUTH_ENABLED).toBe(false);
  });
});

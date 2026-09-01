import { describe, expect, it } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";

const base = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/vistablox",
  BETTER_AUTH_SECRET: "a-secure-development-secret-value",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "user",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "VistaBlox <no-reply@example.com>",
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
      DIDIT_CALLBACK_URL: "https://app.vistablox.eu/kyc/complete",
      DIDIT_WEBHOOK_SECRET: "didit-webhook-secret-for-test",
      DIDIT_APPLICATION_ID: "c5f501a8-0a32-42cd-ac24-13d0d0b15699",
      DIDIT_ENVIRONMENT: "sandbox",
    });

    expect(result.DIDIT_API_BASE_URL).toBe("https://verification.didit.me");
    expect(result.DIDIT_ENVIRONMENT).toBe("sandbox");
  });
});

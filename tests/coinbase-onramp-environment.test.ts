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

const coinbase = {
  COINBASE_CDP_API_KEY_ID: "4f9a6c2e-5b1d-4e8f-9a3c-7d2b1e6f0a94",
  COINBASE_CDP_API_KEY_SECRET: "cdp-secret",
  COINBASE_ONRAMP_REDIRECT_URL: "https://app.vistablox.io/funding/complete",
};

describe("Coinbase onramp webhook configuration", () => {
  it("leaves the webhook disabled when the secret is unset or empty", () => {
    expect(loadEnvironment({ ...base, ...coinbase }).COINBASE_ONRAMP_WEBHOOK_SECRET).toBeUndefined();
    expect(
      loadEnvironment({ ...base, ...coinbase, COINBASE_ONRAMP_WEBHOOK_SECRET: "" })
        .COINBASE_ONRAMP_WEBHOOK_SECRET,
    ).toBeUndefined();
  });

  it("accepts the secret alongside the CDP onramp settings", () => {
    expect(
      loadEnvironment({ ...base, ...coinbase, COINBASE_ONRAMP_WEBHOOK_SECRET: "cdp-webhook-secret-value" })
        .COINBASE_ONRAMP_WEBHOOK_SECRET,
    ).toBe("cdp-webhook-secret-value");
  });

  it("rejects the secret without the CDP onramp settings", () => {
    expect(() =>
      loadEnvironment({ ...base, COINBASE_ONRAMP_WEBHOOK_SECRET: "cdp-webhook-secret-value" }),
    ).toThrow();
  });

  it("rejects a secret too short to be a real signing key", () => {
    expect(() =>
      loadEnvironment({ ...base, ...coinbase, COINBASE_ONRAMP_WEBHOOK_SECRET: "short" }),
    ).toThrow();
  });
});

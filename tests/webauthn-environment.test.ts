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

describe("WEBAUTHN_RP_ID configuration", () => {
  it("is optional and left undefined when unset (falls back to BETTER_AUTH_URL's hostname elsewhere)", () => {
    const result = loadEnvironment(base);
    expect(result.WEBAUTHN_RP_ID).toBeUndefined();
  });

  it("accepts a rpId equal to BETTER_AUTH_URL's hostname", () => {
    const result = loadEnvironment({
      ...base,
      BETTER_AUTH_URL: "https://api.vistablox.io",
      WEBAUTHN_RP_ID: "api.vistablox.io",
    });
    expect(result.WEBAUTHN_RP_ID).toBe("api.vistablox.io");
  });

  it("accepts a rpId that BETTER_AUTH_URL's hostname is a subdomain of", () => {
    const result = loadEnvironment({
      ...base,
      BETTER_AUTH_URL: "https://api.vistablox.io",
      WEBAUTHN_RP_ID: "vistablox.io",
    });
    expect(result.WEBAUTHN_RP_ID).toBe("vistablox.io");
  });

  it("rejects a rpId BETTER_AUTH_URL's hostname is neither equal to nor a subdomain of", () => {
    expect(() =>
      loadEnvironment({
        ...base,
        BETTER_AUTH_URL: "https://unrelated.example.com",
        WEBAUTHN_RP_ID: "api.vistablox.io",
      }),
    ).toThrow("BETTER_AUTH_URL's hostname must equal WEBAUTHN_RP_ID or be a subdomain of it");
  });

  it("rejects a rpId that is merely a suffix match, not a real subdomain boundary", () => {
    // "notapi.vistablox.io" ends with "api.vistablox.io" as a raw string,
    // but is not a subdomain of it -- the check must be label-aware
    // (endsWith(".rpId") or exact match), not a bare string suffix test.
    expect(() =>
      loadEnvironment({
        ...base,
        BETTER_AUTH_URL: "https://notapi.vistablox.io",
        WEBAUTHN_RP_ID: "api.vistablox.io",
      }),
    ).toThrow("BETTER_AUTH_URL's hostname must equal WEBAUTHN_RP_ID or be a subdomain of it");
  });

  it.each([
    ["a scheme", "https://api.vistablox.io"],
    ["a port", "api.vistablox.io:3000"],
    ["a path", "api.vistablox.io/webauthn"],
    ["a trailing dot", "api.vistablox.io."],
    ["uppercase letters", "API.vistablox.io"],
    ["whitespace", "api.vistablox.io "],
  ])("rejects a WEBAUTHN_RP_ID with %s", (_label, value) => {
    expect(() =>
      loadEnvironment({
        ...base,
        BETTER_AUTH_URL: "https://api.vistablox.io",
        WEBAUTHN_RP_ID: value,
      }),
    ).toThrow();
  });
});

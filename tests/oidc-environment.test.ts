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

describe("OIDC environment configuration", () => {
  it("parses a valid JWKS and redirect URI list", () => {
    const result = loadEnvironment({
      ...base,
      OIDC_JWKS: JSON.stringify({ keys: [{ kty: "RSA", n: "...", e: "AQAB", d: "..." }] }),
      OIDC_NATIVE_REDIRECT_URIS: " com.vistablox.app:/oauth/callback , http://127.0.0.1/callback ",
    });

    expect(result.OIDC_JWKS.keys).toHaveLength(1);
    expect(result.OIDC_NATIVE_REDIRECT_URIS).toEqual([
      "com.vistablox.app:/oauth/callback",
      "http://127.0.0.1/callback",
    ]);
  });

  it("rejects OIDC_JWKS that is not valid JSON", () => {
    expect(() =>
      loadEnvironment({
        ...base,
        OIDC_JWKS: "not-json",
        OIDC_NATIVE_REDIRECT_URIS: "com.vistablox.app:/oauth/callback",
      }),
    ).toThrow("OIDC_JWKS must be a JSON Web Key Set");
  });

  it("rejects OIDC_JWKS with an empty keys array", () => {
    expect(() =>
      loadEnvironment({
        ...base,
        OIDC_JWKS: JSON.stringify({ keys: [] }),
        OIDC_NATIVE_REDIRECT_URIS: "com.vistablox.app:/oauth/callback",
      }),
    ).toThrow("OIDC_JWKS must be a JSON Web Key Set");
  });

  it("rejects a blank OIDC_NATIVE_REDIRECT_URIS", () => {
    expect(() =>
      loadEnvironment({
        ...base,
        OIDC_JWKS: JSON.stringify({ keys: [{ kty: "oct", k: "test" }] }),
        OIDC_NATIVE_REDIRECT_URIS: "",
      }),
    ).toThrow();
  });
});

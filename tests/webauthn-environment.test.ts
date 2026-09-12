import { describe, expect, it } from "vitest";

import { loadEnvironment, resolveWebAuthnSettings } from "../src/config/environment.js";

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

// Staging runs NODE_ENV=production with APP_ENV=staging.
const staging = {
  ...base,
  NODE_ENV: "production",
  APP_ENV: "staging",
  BETTER_AUTH_URL: "https://api.vistablox.io",
  WEBAUTHN_RP_ID: "api.vistablox.io",
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

describe("WEBAUTHN_ORIGIN configuration", () => {
  it("is left undefined when unset or empty, and falls back to BETTER_AUTH_URL's origin", () => {
    for (const value of [undefined, "", " , ,"]) {
      const result = loadEnvironment({
        ...base,
        BETTER_AUTH_URL: "https://api.vistablox.io",
        ...(value === undefined ? {} : { WEBAUTHN_ORIGIN: value }),
      });
      expect(result.WEBAUTHN_ORIGIN).toBeUndefined();
      expect(resolveWebAuthnSettings(result)).toEqual({
        passkey: {
          rpId: "api.vistablox.io",
          origins: ["https://api.vistablox.io"],
        },
        staffCeremony: { rpId: "api.vistablox.io", origins: ["https://api.vistablox.io"] },
        relatedOrigins: [],
      });
    }
  });

  it("boots a staging-shaped environment with a single origin", () => {
    const result = loadEnvironment({ ...staging, WEBAUTHN_ORIGIN: "https://api.vistablox.io" });
    expect(result.WEBAUTHN_ORIGIN).toEqual(["https://api.vistablox.io"]);
    expect(resolveWebAuthnSettings(result).relatedOrigins).toEqual([]);
  });

  it("parses a comma-separated list, trimming whitespace and dropping empty entries", () => {
    const result = loadEnvironment({
      ...staging,
      WEBAUTHN_ORIGIN: " https://api.vistablox.io ,, https://admin.vistablox.io ,",
    });
    expect(result.WEBAUTHN_ORIGIN).toEqual([
      "https://api.vistablox.io",
      "https://admin.vistablox.io",
    ]);
  });

  it("accepts an explicit non-default port", () => {
    const result = loadEnvironment({ ...base, WEBAUTHN_ORIGIN: "https://admin.vistablox.io:8443" });
    expect(result.WEBAUTHN_ORIGIN).toEqual(["https://admin.vistablox.io:8443"]);
  });

  it.each([
    ["a wildcard host", "https://*.vistablox.io"],
    ["a path", "https://admin.vistablox.io/login"],
    ["a trailing slash", "https://admin.vistablox.io/"],
    ["a trailing dot", "https://admin.vistablox.io."],
    ["a query string", "https://admin.vistablox.io?x=1"],
    ["a default port spelled out", "https://admin.vistablox.io:443"],
    ["port 0", "https://admin.vistablox.io:0"],
    ["an uppercase host", "https://Admin.vistablox.io"],
    ["plain http on a real host", "http://admin.vistablox.io"],
    ["an IPv4 address", "https://203.0.113.10"],
    ["an IPv6 address", "https://[2001:db8::1]"],
    ["a bare single-label host", "https://io"],
    ["a bare hostname", "admin.vistablox.io"],
    ["an Android app origin", "android:apk-key-hash:abc123"],
    ["one bad entry among good ones", "https://api.vistablox.io,https://*.vistablox.io"],
  ])("rejects an entry with %s", (_label, value) => {
    expect(() => loadEnvironment({ ...base, WEBAUTHN_ORIGIN: value })).toThrow(
      "each entry must be an exact origin",
    );
  });

  it("rejects a duplicate entry", () => {
    expect(() =>
      loadEnvironment({
        ...base,
        WEBAUTHN_ORIGIN: "https://admin.vistablox.io, https://admin.vistablox.io",
      }),
    ).toThrow("WEBAUTHN_ORIGIN: duplicate entry");
  });

  it("allows localhost and loopback for local development only", () => {
    expect(
      loadEnvironment({ ...base, WEBAUTHN_ORIGIN: "http://localhost:3000,https://127.0.0.1:8443" })
        .WEBAUTHN_ORIGIN,
    ).toEqual(["http://localhost:3000", "https://127.0.0.1:8443"]);
    for (const local of ["http://localhost:3000", "https://localhost:8443", "https://127.0.0.1"]) {
      expect(() =>
        loadEnvironment({ ...staging, WEBAUTHN_ORIGIN: `https://api.vistablox.io,${local}` }),
      ).toThrow("every entry must be https in production");
    }
  });

  it("refuses related origins spanning more than five registrable-domain labels", () => {
    const others = ["a", "b", "c", "d", "e"].map((label) => `https://www.${label}-vistablox.com`);
    // Four other sites plus admin/ops.vistablox.io (one label between
    // them) is exactly five -- accepted.
    expect(
      loadEnvironment({
        ...staging,
        WEBAUTHN_ORIGIN: [
          "https://api.vistablox.io",
          ...others.slice(0, 4),
          "https://admin.vistablox.io",
          "https://ops.vistablox.io",
        ].join(","),
      }).WEBAUTHN_ORIGIN,
    ).toHaveLength(7);
    expect(() =>
      loadEnvironment({
        ...staging,
        WEBAUTHN_ORIGIN: ["https://api.vistablox.io", ...others, "https://admin.vistablox.io"].join(","),
      }),
    ).toThrow("more than 5 distinct registrable-domain labels");
  });
});

describe("resolveWebAuthnSettings", () => {
  it("keeps related origins (the admin console) staff-only, and the Android app origins customer-usable", () => {
    const settings = resolveWebAuthnSettings(
      loadEnvironment({
        ...staging,
        WEBAUTHN_ORIGIN: "https://api.vistablox.io,https://admin.vistablox.io",
        PASSKEY_ANDROID_ORIGINS: "android:apk-key-hash:abc123",
      }),
    );

    expect(settings).toEqual({
      passkey: {
        rpId: "api.vistablox.io",
        origins: [
          "https://api.vistablox.io",
          "https://admin.vistablox.io",
          "android:apk-key-hash:abc123",
        ],
      },
      staffCeremony: {
        rpId: "api.vistablox.io",
        origins: ["https://api.vistablox.io", "https://admin.vistablox.io"],
      },
      relatedOrigins: ["https://admin.vistablox.io"],
    });
  });

  it("treats a subdomain of the rpId as the rpId's own origin, not a related one", () => {
    const settings = resolveWebAuthnSettings(
      loadEnvironment({
        ...staging,
        WEBAUTHN_ORIGIN: "https://api.vistablox.io,https://eu.api.vistablox.io,https://admin.vistablox.io",
      }),
    );

    expect(settings.relatedOrigins).toEqual(["https://admin.vistablox.io"]);
    expect(settings.passkey.origins).toEqual([
      "https://api.vistablox.io",
      "https://eu.api.vistablox.io",
      "https://admin.vistablox.io",
    ]);
  });
});

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

// zod's parse error message is the issue list serialized as JSON, so the
// quotes arrive escaped (\"strict\"); match either form.
const MUST_BE_STRICT = /PLAY_INTEGRITY_POLICY must be \\?"strict\\?" in production/;

// Staging runs NODE_ENV=production (the Docker images set it), so the
// "strict only in production" rule has to key on the deployment tier
// (APP_ENV), not on NODE_ENV alone. Unset APP_ENV counts as production.
describe("PLAY_INTEGRITY_POLICY vs. the deployment tier", () => {
  it("refuses the default (disabled) in a NODE_ENV=production build with APP_ENV unset", () => {
    expect(() => loadEnvironment({ ...base, NODE_ENV: "production" })).toThrow(MUST_BE_STRICT);
  });

  it("treats an empty APP_ENV like an unset one (production)", () => {
    expect(() =>
      loadEnvironment({ ...base, NODE_ENV: "production", APP_ENV: "", PLAY_INTEGRITY_POLICY: "disabled" }),
    ).toThrow(MUST_BE_STRICT);
  });

  it("refuses relaxed when APP_ENV=production", () => {
    expect(() =>
      loadEnvironment({ ...base, NODE_ENV: "production", APP_ENV: "production", PLAY_INTEGRITY_POLICY: "relaxed" }),
    ).toThrow(MUST_BE_STRICT);
  });

  it("accepts strict in production", () => {
    const result = loadEnvironment({
      ...base,
      NODE_ENV: "production",
      APP_ENV: "production",
      PLAY_INTEGRITY_POLICY: "strict",
    });
    expect(result.PLAY_INTEGRITY_POLICY).toBe("strict");
  });

  it("accepts disabled on staging, even though staging runs NODE_ENV=production", () => {
    const result = loadEnvironment({ ...base, NODE_ENV: "production", APP_ENV: "staging" });
    expect(result.APP_ENV).toBe("staging");
    expect(result.PLAY_INTEGRITY_POLICY).toBe("disabled");
  });

  it("accepts disabled outside a production build (local development)", () => {
    const result = loadEnvironment({ ...base, NODE_ENV: "development" });
    expect(result.PLAY_INTEGRITY_POLICY).toBe("disabled");
  });

  it("rejects an unknown APP_ENV value", () => {
    expect(() => loadEnvironment({ ...base, NODE_ENV: "production", APP_ENV: "prod" })).toThrow();
  });
});

// Mirrors android-attestation-verifier.ts's own normalizeCertDigest rule
// (strip non-hex, lowercase, must land on 64 chars) -- catching a typo'd or
// truncated digest here means it fails loudly at boot instead of surfacing
// much later as a silent, hard-to-diagnose enrolment rejection.
describe("ANDROID_ATTESTATION_CERT_DIGESTS", () => {
  const SIXTY_FOUR_HEX = "aa".repeat(32);

  it("accepts a plain 64-character hex digest", () => {
    const result = loadEnvironment({ ...base, ANDROID_ATTESTATION_CERT_DIGESTS: SIXTY_FOUR_HEX });
    expect(result.ANDROID_ATTESTATION_CERT_DIGESTS).toEqual([SIXTY_FOUR_HEX]);
  });

  it("accepts a colon-separated, uppercase digest (openssl/keytool's own format)", () => {
    const colonSeparatedUppercase = SIXTY_FOUR_HEX.toUpperCase().replace(/(.{2})(?=.)/g, "$1:");
    expect(() =>
      loadEnvironment({ ...base, ANDROID_ATTESTATION_CERT_DIGESTS: colonSeparatedUppercase }),
    ).not.toThrow();
  });

  it("accepts multiple comma-separated digests, each independently valid", () => {
    const other = "bb".repeat(32);
    const result = loadEnvironment({
      ...base,
      ANDROID_ATTESTATION_CERT_DIGESTS: `${SIXTY_FOUR_HEX},${other}`,
    });
    expect(result.ANDROID_ATTESTATION_CERT_DIGESTS).toEqual([SIXTY_FOUR_HEX, other]);
  });

  it("accepts unset/empty, same as today -- enrolment itself refuses with no digests configured", () => {
    expect(() =>
      loadEnvironment({ ...base, ANDROID_ATTESTATION_CERT_DIGESTS: "" }),
    ).not.toThrow();
  });

  it("rejects a digest one character short of 64", () => {
    expect(() =>
      loadEnvironment({ ...base, ANDROID_ATTESTATION_CERT_DIGESTS: SIXTY_FOUR_HEX.slice(0, 63) }),
    ).toThrow(/ANDROID_ATTESTATION_CERT_DIGESTS/);
  });

  it("rejects a digest one character over 64", () => {
    expect(() =>
      loadEnvironment({ ...base, ANDROID_ATTESTATION_CERT_DIGESTS: `${SIXTY_FOUR_HEX}a` }),
    ).toThrow(/ANDROID_ATTESTATION_CERT_DIGESTS/);
  });

  it("rejects non-hex garbage even at the right length", () => {
    const garbage = "z".repeat(64);
    expect(() =>
      loadEnvironment({ ...base, ANDROID_ATTESTATION_CERT_DIGESTS: garbage }),
    ).toThrow(/ANDROID_ATTESTATION_CERT_DIGESTS/);
  });

  it("rejects the set when just one of several entries is malformed", () => {
    expect(() =>
      loadEnvironment({
        ...base,
        ANDROID_ATTESTATION_CERT_DIGESTS: `${SIXTY_FOUR_HEX},not-a-digest`,
      }),
    ).toThrow(/ANDROID_ATTESTATION_CERT_DIGESTS/);
  });
});

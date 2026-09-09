import { describe, expect, it } from "vitest";

import {
  InternalApiSignatureVerifier,
  signInternalRequest,
} from "../src/modules/identity/infrastructure/internal-api-signature.js";

const secret = "an-internal-kyc-api-secret-value-32-chars";
const now = new Date("2026-09-01T12:00:00.000Z");

describe("internal API request signing", () => {
  it("accepts a request signed with the matching secret", () => {
    const { signature, timestamp } = signInternalRequest({
      secret,
      method: "POST",
      path: "/internal/kyc/sessions",
      body: { account_id: "acct_01", nested: { z: 2, a: 1 } },
      now,
    });

    expect(() =>
      new InternalApiSignatureVerifier(secret, () => now).verify({
        method: "POST",
        path: "/internal/kyc/sessions",
        body: { nested: { a: 1, z: 2 }, account_id: "acct_01" },
        signature,
        timestamp,
      }),
    ).not.toThrow();
  });

  it("accepts a GET request with no body", () => {
    const { signature, timestamp } = signInternalRequest({
      secret,
      method: "GET",
      path: "/internal/kyc/status?account_id=acct_01",
      now,
    });

    expect(() =>
      new InternalApiSignatureVerifier(secret, () => now).verify({
        method: "GET",
        path: "/internal/kyc/status?account_id=acct_01",
        body: undefined,
        signature,
        timestamp,
      }),
    ).not.toThrow();
  });

  it.each([
    {
      name: "wrong secret",
      build: () => signInternalRequest({ secret: "a-different-secret-value-32-chars", method: "GET", path: "/internal/kyc/status", now }),
    },
    {
      name: "tampered path",
      build: () => signInternalRequest({ secret, method: "GET", path: "/internal/kyc/status?account_id=acct_02", now }),
    },
    {
      name: "tampered method",
      build: () => signInternalRequest({ secret, method: "DELETE", path: "/internal/kyc/status", now }),
    },
  ])("rejects a request with $name", ({ build }) => {
    const { signature, timestamp } = build();
    expect(() =>
      new InternalApiSignatureVerifier(secret, () => now).verify({
        method: "GET",
        path: "/internal/kyc/status",
        body: undefined,
        signature,
        timestamp,
      }),
    ).toThrow("The internal request signature or timestamp is invalid.");
  });

  it("rejects a stale timestamp outside the 60-second window", () => {
    const stale = new Date(now.getTime() - 61_000);
    const { signature, timestamp } = signInternalRequest({
      secret,
      method: "GET",
      path: "/internal/kyc/status",
      now: stale,
    });

    expect(() =>
      new InternalApiSignatureVerifier(secret, () => now).verify({
        method: "GET",
        path: "/internal/kyc/status",
        body: undefined,
        signature,
        timestamp,
      }),
    ).toThrow("The internal request signature or timestamp is invalid.");
  });

  it("rejects a missing or malformed signature", () => {
    const { timestamp } = signInternalRequest({ secret, method: "GET", path: "/internal/kyc/status", now });
    const verifier = new InternalApiSignatureVerifier(secret, () => now);

    expect(() =>
      verifier.verify({ method: "GET", path: "/internal/kyc/status", body: undefined, signature: undefined, timestamp }),
    ).toThrow();
    expect(() =>
      verifier.verify({ method: "GET", path: "/internal/kyc/status", body: undefined, signature: "not-hex", timestamp }),
    ).toThrow();
  });
});

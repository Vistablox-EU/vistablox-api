import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { base64DigestToHex } from "../src/modules/auth/infrastructure/google-play-integrity.decoder.js";

// Google's Play Integrity API returns certificateSha256Digest as base64,
// while verifyPlayIntegrityToken compares against ANDROID_ATTESTATION_CERT_DIGESTS
// (hex) -- the same allowlist key-attestation uses. Without this
// conversion the comparison can never match, so the digest allowlist
// silently rejects every real Play Integrity verdict whenever the policy
// isn't "disabled".
describe("base64DigestToHex", () => {
  it("converts a base64-encoded SHA-256 digest to lowercase hex", () => {
    const digestBytes = createHash("sha256").update("a-cert").digest();
    const base64 = digestBytes.toString("base64");

    const hex = base64DigestToHex(base64);

    expect(hex).toBe(digestBytes.toString("hex"));
    expect(hex).toHaveLength(64);
  });

  it("also accepts the base64url variant", () => {
    const digestBytes = createHash("sha256").update("another-cert").digest();
    const base64url = digestBytes.toString("base64url");

    const hex = base64DigestToHex(base64url);

    expect(hex).toBe(digestBytes.toString("hex"));
  });
});

import { createHash } from "node:crypto";

/**
 * The value every platform attestation/integrity call signs over:
 * SHA-256(ASCII(challenge + "." + bio_jkt)), base64url-encoded. Binds a
 * specific attestation to a specific challenge and a specific key in one
 * step, so an attacker can't front-run a challenge with a different key or
 * replay one attestation against a different challenge.
 */
export function computeDeviceBinding(challenge: string, bioJkt: string): string {
  return createHash("sha256")
    .update(`${challenge}.${bioJkt}`, "ascii")
    .digest("base64url");
}

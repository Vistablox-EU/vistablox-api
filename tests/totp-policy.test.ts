import { describe, expect, it } from "vitest";

import {
  generateBackupCodes,
  hashBackupCode,
  normalizeBackupCode,
} from "../src/modules/auth/domain/totp-policy.js";

describe("TOTP backup code policy", () => {
  it("generates the requested number of distinct, dash-formatted codes", () => {
    const codes = generateBackupCodes(10);

    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    }
  });

  it("hashes deterministically for the same code and key, and differently for a different key", () => {
    const a = hashBackupCode("ABCDE-FGHJK", "key-one");
    const b = hashBackupCode("ABCDE-FGHJK", "key-one");
    const c = hashBackupCode("ABCDE-FGHJK", "key-two");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("normalizes case and surrounding whitespace before hashing", () => {
    expect(hashBackupCode(" abcde-fghjk ", "key")).toBe(hashBackupCode("ABCDE-FGHJK", "key"));
  });

  it("normalizes to trimmed uppercase", () => {
    expect(normalizeBackupCode(" abcde-fghjk ")).toBe("ABCDE-FGHJK");
  });
});

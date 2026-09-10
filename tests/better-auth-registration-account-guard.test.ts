import { describe, expect, it } from "vitest";

import { findRegistrationAccountId } from "../src/modules/auth/infrastructure/better-auth-registration-account-guard.plugin.js";

describe("Better Auth registration account guard", () => {
  it("identifies the earliest-linked account as the registration account", () => {
    const accounts = [
      { id: "acct_apple", createdAt: new Date("2026-02-01T00:00:00.000Z") },
      { id: "acct_google", createdAt: new Date("2026-01-01T00:00:00.000Z") },
    ];

    expect(findRegistrationAccountId(accounts)).toBe("acct_google");
  });

  it("is unaffected by input ordering", () => {
    const accounts = [
      { id: "acct_google", createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { id: "acct_apple", createdAt: new Date("2026-02-01T00:00:00.000Z") },
    ];

    expect(findRegistrationAccountId(accounts)).toBe("acct_google");
  });

  it("returns null when there are no linked accounts", () => {
    expect(findRegistrationAccountId([])).toBeNull();
  });
});

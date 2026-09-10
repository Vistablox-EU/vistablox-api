import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";

import { BetterAuthLoginMethodUnlinker } from "../src/modules/auth/infrastructure/better-auth-login-method-unlinker.js";
import {
  LoginMethodNotLinkedError,
  RegistrationLoginMethodLockedError,
} from "../src/modules/auth/application/login-method-unlinker.js";
import type { VistaBloxAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";

function fakeAuth(overrides: {
  accounts?: Array<{ id: string; providerId: string }>;
  unlinkAccount?: (input: unknown) => Promise<unknown>;
}): VistaBloxAuth {
  return {
    api: {
      listUserAccounts: vi.fn().mockResolvedValue(overrides.accounts ?? []),
      unlinkAccount: overrides.unlinkAccount ?? vi.fn().mockResolvedValue({ status: true }),
    },
  } as unknown as VistaBloxAuth;
}

describe("BetterAuthLoginMethodUnlinker", () => {
  it("resolves the provider's account id and unlinks it", async () => {
    const unlinkAccount = vi.fn().mockResolvedValue({ status: true });
    const auth = fakeAuth({
      accounts: [
        { id: "acct_google", providerId: "google" },
        { id: "acct_apple", providerId: "apple" },
      ],
      unlinkAccount,
    });

    await new BetterAuthLoginMethodUnlinker(auth).unlink("apple", {});

    expect(unlinkAccount).toHaveBeenCalledWith(
      expect.objectContaining({ body: { accountId: "acct_apple" } }),
    );
  });

  it("throws LoginMethodNotLinkedError when the provider isn't linked", async () => {
    const auth = fakeAuth({ accounts: [{ id: "acct_google", providerId: "google" }] });

    await expect(new BetterAuthLoginMethodUnlinker(auth).unlink("apple", {})).rejects.toThrow(
      LoginMethodNotLinkedError,
    );
  });

  it("translates the registration guard's error into a domain error", async () => {
    const unlinkAccount = vi.fn().mockRejectedValue(
      APIError.from("FORBIDDEN", { code: "REGISTRATION_LOGIN_METHOD_LOCKED", message: "locked" }),
    );
    const auth = fakeAuth({
      accounts: [{ id: "acct_google", providerId: "google" }],
      unlinkAccount,
    });

    await expect(new BetterAuthLoginMethodUnlinker(auth).unlink("google", {})).rejects.toThrow(
      RegistrationLoginMethodLockedError,
    );
  });

  it("treats Better Auth's own last-account guard the same as the registration lock", async () => {
    const unlinkAccount = vi.fn().mockRejectedValue(
      APIError.from("BAD_REQUEST", { code: "FAILED_TO_UNLINK_LAST_ACCOUNT", message: "last" }),
    );
    const auth = fakeAuth({
      accounts: [{ id: "acct_google", providerId: "google" }],
      unlinkAccount,
    });

    await expect(new BetterAuthLoginMethodUnlinker(auth).unlink("google", {})).rejects.toThrow(
      RegistrationLoginMethodLockedError,
    );
  });
});

import { describe, expect, it } from "vitest";

import { createBetterAuthPasskeyChallengeHeaderPlugin } from "../src/modules/auth/infrastructure/better-auth-passkey-challenge-header.plugin.js";

describe("createBetterAuthPasskeyChallengeHeaderPlugin", () => {
  it("matches only the verify-* paths for the before hook", () => {
    const plugin = createBetterAuthPasskeyChallengeHeaderPlugin();
    const [beforeHook] = plugin.hooks!.before!;

    expect(beforeHook!.matcher({ path: "/passkey/verify-registration" } as never)).toBe(true);
    expect(beforeHook!.matcher({ path: "/passkey/verify-authentication" } as never)).toBe(true);
    expect(beforeHook!.matcher({ path: "/passkey/generate-register-options" } as never)).toBe(false);
    expect(beforeHook!.matcher({ path: "/sign-in/social" } as never)).toBe(false);
    expect(beforeHook!.matcher({ path: undefined } as never)).toBe(false);
  });

  it("matches only the generate-*-options paths for the after hook", () => {
    const plugin = createBetterAuthPasskeyChallengeHeaderPlugin();
    const [afterHook] = plugin.hooks!.after!;

    expect(afterHook!.matcher({ path: "/passkey/generate-register-options" } as never)).toBe(true);
    expect(afterHook!.matcher({ path: "/passkey/generate-authenticate-options" } as never)).toBe(true);
    expect(afterHook!.matcher({ path: "/passkey/verify-registration" } as never)).toBe(false);
    expect(afterHook!.matcher({ path: undefined } as never)).toBe(false);
  });
});

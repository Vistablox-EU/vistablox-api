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

// Regression coverage for the hook-merge collision found live on staging:
// better-auth's runBeforeHooks (dispatch.mjs) calls every matching before
// hook with the SAME original context, then .set()s each hook's entire
// returned Cookie header onto a shared accumulator -- so bearer() injecting
// the session cookie and this plugin injecting only the passkey cookie, as
// two independent hook results, had the second one silently erase the
// first's. These tests call the hook's handler directly (bypassing
// runBeforeHooks and its `returnHeaders: true` wrapping, confirmed by
// inspection to make the handler return its raw { context } value rather
// than a { response, headers } envelope) and assert on the single combined
// Headers object it produces, which is exactly what has to be right for the
// real dispatch's merge to end up with both cookies.
describe("createBetterAuthPasskeyChallengeHeaderPlugin: before-hook cookie combination", () => {
  function fakeCtx(headersInit: Record<string, string>) {
    return {
      path: "/passkey/verify-authentication",
      request: new Request("https://api.vistablox.io/api/auth/passkey/verify-authentication", {
        method: "POST",
        headers: headersInit,
      }),
      headers: undefined,
      context: {
        authCookies: { sessionToken: { name: "vb.session_token" } },
        createAuthCookie: (name: string) => ({ name: `vb.${name}` }),
      },
    };
  }

  it("combines the derived session cookie and the passkey challenge cookie into one Cookie header", async () => {
    const plugin = createBetterAuthPasskeyChallengeHeaderPlugin();
    const [beforeHook] = plugin.hooks!.before!;

    const ctx = fakeCtx({
      authorization: "Bearer session-value.session-signature",
      "x-passkey-challenge": "challenge-value.challenge-signature",
    });
    const result = (await beforeHook!.handler(ctx as never)) as
      | { context: { headers: Headers } }
      | undefined;

    expect(result).toBeDefined();
    const cookie = result!.context.headers.get("cookie");
    expect(cookie).toContain("vb.session_token=session-value.session-signature");
    expect(cookie).toContain("vb.better-auth-passkey=challenge-value.challenge-signature");
  });

  it("still sets only the passkey cookie when there's no Authorization header", async () => {
    const plugin = createBetterAuthPasskeyChallengeHeaderPlugin();
    const [beforeHook] = plugin.hooks!.before!;

    const ctx = fakeCtx({ "x-passkey-challenge": "challenge-value.challenge-signature" });
    const result = (await beforeHook!.handler(ctx as never)) as
      | { context: { headers: Headers } }
      | undefined;

    expect(result).toBeDefined();
    const cookie = result!.context.headers.get("cookie");
    expect(cookie).toContain("vb.better-auth-passkey=challenge-value.challenge-signature");
    expect(cookie).not.toContain("vb.session_token");
  });

  it("is a no-op with neither an Authorization header nor a challenge header", async () => {
    const plugin = createBetterAuthPasskeyChallengeHeaderPlugin();
    const [beforeHook] = plugin.hooks!.before!;

    const ctx = fakeCtx({});
    const result = await beforeHook!.handler(ctx as never);

    expect(result).toBeUndefined();
  });

  it("does not set a session cookie for a bearer token with no signature (out of contract, but must not crash)", async () => {
    const plugin = createBetterAuthPasskeyChallengeHeaderPlugin();
    const [beforeHook] = plugin.hooks!.before!;

    const ctx = fakeCtx({
      authorization: "Bearer no-dot-token",
      "x-passkey-challenge": "challenge-value.challenge-signature",
    });
    const result = (await beforeHook!.handler(ctx as never)) as
      | { context: { headers: Headers } }
      | undefined;

    expect(result).toBeDefined();
    const cookie = result!.context.headers.get("cookie");
    expect(cookie).toContain("vb.better-auth-passkey=challenge-value.challenge-signature");
    expect(cookie).not.toContain("vb.session_token");
  });
});

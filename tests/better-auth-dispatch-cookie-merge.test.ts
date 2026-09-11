import { bearer } from "better-auth/plugins";
import { createAuthEndpoint, dispatchAuthEndpoint } from "better-auth/api";
import { serializeSignedCookie } from "better-call";
import { describe, expect, it } from "vitest";

import { createBetterAuthPasskeyChallengeHeaderPlugin } from "../src/modules/auth/infrastructure/better-auth-passkey-challenge-header.plugin.js";

const SECRET = "test-secret-at-least-32-characters-long";

/**
 * A validly-signed bearer token in the same shape bearer()'s own before-hook
 * accepts: bearer/index.mjs signs an undotted raw value the same way when
 * `token.includes(".")` is false (serializeSignedCookie("", token, secret),
 * then `.replace("=", "")`) -- reproduced verbatim so the resulting token is
 * genuinely well-formed, not just something that happens to contain a dot.
 */
async function signBearerToken(value: string): Promise<string> {
  const serialized = await serializeSignedCookie("", value, SECRET);
  return serialized.replace("=", "");
}

/**
 * Regression coverage for the hook-merge collision (bearer's session cookie
 * vs. this plugin's passkey-challenge cookie, both independent before-hooks
 * writing Cookie -- see better-auth-passkey-challenge-header.plugin.ts's own
 * doc comment for the full mechanism). Unlike the hook-level tests in
 * better-auth-passkey-challenge-header-plugin.test.ts, this dispatches a
 * stub endpoint through better-auth's OWN exported dispatchAuthEndpoint --
 * the real runBeforeHooks merge, the real bearer() plugin -- so it fails if
 * a better-auth upgrade changes how before-hook results are merged, or if
 * this plugin's own handler regresses to only writing its own cookie again.
 * It does NOT read the factory's actual plugin list or registration order
 * (options.plugins below is hard-coded to just these two, not built the way
 * createBetterAuth does) -- it can't catch the factory reordering plugins,
 * or some other plugin starting to also write Cookie. Making that true
 * would mean extracting the factory's plugin-list construction into
 * something this test and createBetterAuth both call. No database and no
 * WebAuthn ceremony needed either way: the stub endpoint just reports back
 * the Cookie header it was handed, which is what this bug class is
 * actually about.
 */
describe("real before-hook dispatch: bearer + passkey-challenge cookie merge", () => {
  it("combines bearer's session cookie and the passkey challenge cookie for a real dispatch", async () => {
    let cookieSeenByEndpoint: string | null | undefined;
    const stubEndpoint = createAuthEndpoint(
      "/passkey/verify-authentication",
      { method: "POST" },
      async (ctx: { headers?: Headers | undefined }) => {
        cookieSeenByEndpoint = ctx.headers?.get("cookie") ?? null;
        return { ok: true };
      },
    );

    const signedToken = await signBearerToken("session-value");

    await dispatchAuthEndpoint(stubEndpoint, {
      path: "/passkey/verify-authentication",
      method: "POST",
      headers: new Headers({
        authorization: `Bearer ${signedToken}`,
        "x-passkey-challenge": "challenge-value.challenge-signature",
      }),
      context: {
        secret: SECRET,
        authCookies: {
          sessionToken: { name: "vb.session_token", attributes: {} },
          sessionData: { name: "vb.session_data", attributes: {} },
          accountData: { name: "vb.account_data", attributes: {} },
          dontRememberToken: { name: "vb.dont_remember", attributes: {} },
        },
        createAuthCookie: (name: string) => ({ name: `vb.${name}`, attributes: {} }),
        // Same order better-auth.factory.ts registers them in: bearer()
        // first, this plugin right after.
        options: { plugins: [bearer(), createBetterAuthPasskeyChallengeHeaderPlugin()] },
        logger: {
          level: "error",
          info: () => {},
          warn: () => {},
          error: () => {},
          success: () => {},
          debug: () => {},
        },
      },
      // A minimal fake of AuthContext -- the full type also carries
      // getPlugin/hasPlugin and ~30 other members this dispatch path never
      // touches. Matches this codebase's existing convention for testing
      // against better-auth's own types (see better-auth-staff-account-guard.test.ts).
    } as never);

    expect(cookieSeenByEndpoint).toBeDefined();
    expect(cookieSeenByEndpoint).toContain("vb.better-auth-passkey=challenge-value.challenge-signature");
    // bearer signs/decodes the token itself; asserting the cookie name and
    // that a value is present is the meaningful check here, not the exact
    // signed bytes (covered already by the hook-level tests).
    expect(cookieSeenByEndpoint).toMatch(/vb\.session_token=\S+/);
  });
});

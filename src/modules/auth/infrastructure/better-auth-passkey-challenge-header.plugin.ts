import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { parseSetCookieHeader, setRequestCookie } from "better-auth/cookies/utils";

// The passkey plugin's own cookie option (advanced.webAuthnChallengeCookie),
// not overridden anywhere in this factory -- confirmed against
// @better-auth/passkey's default (index.mjs:782) rather than assumed. The
// wire name still goes through ctx.context.createAuthCookie below, so the
// cookiePrefix/secure-prefix logic this factory configures (advanced.cookiePrefix,
// useSecureCookies) is honored automatically, not duplicated here.
const WEBAUTHN_CHALLENGE_COOKIE = "better-auth-passkey";

const GENERATE_OPTIONS_PATHS = new Set([
  "/passkey/generate-register-options",
  "/passkey/generate-authenticate-options",
]);
const VERIFY_PATHS = new Set(["/passkey/verify-registration", "/passkey/verify-authentication"]);

/**
 * A cookie-free path for the passkey challenge, mirroring bearer()'s own
 * token-as-header trick: the mobile client uses credentials: 'omit' (no
 * cookie jar), so the signed challenge cookie @better-auth/passkey sets on
 * generate-*-options never survives the round trip to verify-*, which fails
 * with CHALLENGE_NOT_FOUND. This relays the exact same signed value through
 * a header pair instead -- set-passkey-challenge out, x-passkey-challenge
 * back in, injected as the real cookie into ctx.headers before the passkey
 * plugin's own before-hooks run. The existing cookie path is untouched: if
 * no x-passkey-challenge header is present, this is a no-op and whatever
 * real Cookie header the request carries (the current app build) still
 * works exactly as before.
 */
export function createBetterAuthPasskeyChallengeHeaderPlugin(): BetterAuthPlugin {
  return {
    id: "vistablox-passkey-challenge-header",
    hooks: {
      before: [
        {
          matcher: (context) => VERIFY_PATHS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const headerValue =
              ctx.request?.headers.get("x-passkey-challenge") ??
              ctx.headers?.get("x-passkey-challenge") ??
              null;
            if (headerValue === null) return;

            const webAuthnCookie = ctx.context.createAuthCookie(WEBAUTHN_CHALLENGE_COOKIE);
            const existingHeaders = ctx.request?.headers ?? ctx.headers;
            const headers = new Headers(
              existingHeaders === undefined ? {} : Object.fromEntries(existingHeaders.entries()),
            );
            setRequestCookie(headers, webAuthnCookie.name, headerValue);
            return { context: { headers } };
          }),
        },
      ],
      after: [
        {
          matcher: (context) => GENERATE_OPTIONS_PATHS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const setCookie = ctx.context.responseHeaders?.get("set-cookie");
            if (setCookie === null || setCookie === undefined) return;

            const webAuthnCookie = ctx.context.createAuthCookie(WEBAUTHN_CHALLENGE_COOKIE);
            const parsedCookies = parseSetCookieHeader(setCookie);
            const challengeCookie = parsedCookies.get(webAuthnCookie.name);
            if (
              challengeCookie === undefined ||
              !challengeCookie.value ||
              challengeCookie["max-age"] === 0
            ) {
              return;
            }

            const exposedHeaders =
              ctx.context.responseHeaders?.get("access-control-expose-headers") ?? "";
            const headersSet = new Set(
              exposedHeaders
                .split(",")
                .map((header) => header.trim())
                .filter(Boolean),
            );
            headersSet.add("set-passkey-challenge");
            ctx.setHeader("set-passkey-challenge", challengeCookie.value);
            ctx.setHeader("Access-Control-Expose-Headers", Array.from(headersSet).join(", "));
          }),
        },
      ],
    },
  };
}

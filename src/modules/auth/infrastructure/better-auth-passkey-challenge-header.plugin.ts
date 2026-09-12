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
const BEARER_SCHEME = "bearer ";

function tryDecodeBearerToken(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

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
            const existingHeaders = ctx.request?.headers ?? ctx.headers;
            if (existingHeaders === undefined) return;

            // better-auth's before-hook merge (dispatch.mjs runBeforeHooks)
            // calls every matching hook with the SAME original, unmodified
            // context -- hooks never see each other's contributions -- then
            // .set()s each hook's entire returned Cookie header onto a
            // shared accumulator, one header key at a time. Cookie is a
            // singular header, so whichever hook's returned Cookie value
            // gets merged last wins outright, discarding any other hook's
            // cookie. bearer() (registered earlier in the plugins array)
            // independently injects the session cookie derived from
            // Authorization the same way this hook injects the passkey
            // challenge cookie; if this hook only ever set its own cookie,
            // its result would silently erase bearer's, and verify-* would
            // see no session. So this hook
            // re-derives and re-injects the session cookie too, onto the
            // SAME headers object as the passkey cookie, producing the one
            // complete Cookie value both need. setRequestCookie parses,
            // updates, and re-serializes whatever Cookie is already on the
            // headers object it's given, so calling it twice here correctly
            // combines both rather than the second call clobbering the
            // first the way two separate hooks' results do.
            const headers = new Headers({ ...Object.fromEntries(existingHeaders.entries()) });
            let changed = false;

            const authHeader = existingHeaders.get("authorization");
            if (authHeader !== null && authHeader.slice(0, 7).toLowerCase() === BEARER_SCHEME) {
              const rawToken = authHeader.slice(7).trim();
              // Contract: the mobile client always sends the set-auth-token
              // value byte for byte, already in "value.signature" form --
              // the only shape this needs to handle, since that's also the
              // only form ctx.getSignedCookie re-verifies when the session
              // is actually resolved later. No HMAC/signing work belongs in
              // this hook; an invalid or tampered value still ends up with
              // no session, just via that later verification instead of an
              // upfront check here.
              if (rawToken.includes(".")) {
                const decodedToken = rawToken.includes("%")
                  ? tryDecodeBearerToken(rawToken)
                  : rawToken;
                setRequestCookie(headers, ctx.context.authCookies.sessionToken.name, decodedToken);
                changed = true;
              }
            }

            const challengeHeaderValue =
              ctx.request?.headers.get("x-passkey-challenge") ??
              ctx.headers?.get("x-passkey-challenge") ??
              null;
            if (challengeHeaderValue !== null) {
              const webAuthnCookie = ctx.context.createAuthCookie(WEBAUTHN_CHALLENGE_COOKIE);
              setRequestCookie(headers, webAuthnCookie.name, challengeHeaderValue);
              changed = true;
            }

            if (!changed) return;
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

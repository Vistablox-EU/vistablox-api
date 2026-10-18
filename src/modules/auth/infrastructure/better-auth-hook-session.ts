import { getSessionFromCtx } from "better-auth/api";
import { setRequestCookie } from "better-auth/cookies/utils";

type HookContext = Parameters<typeof getSessionFromCtx>[0];

const BEARER_SCHEME = "bearer ";

function tryDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The signed session token bearer() would turn into the session cookie for
 * this Authorization header, or null when it would leave the request alone.
 * Parsed exactly the way bearer() parses it (better-auth/plugins/bearer):
 * case-insensitive scheme, trimmed, "value.signature" form only, and a
 * percent-encoded value is decoded. A bare token is ignored here because the
 * factory registers bearer({ requireSignature: true }), which ignores it too;
 * the two must change together (a bearer that signs bare tokens itself would
 * otherwise authenticate requests this never looks at). The HMAC is not
 * checked here: the session lookup re-verifies the signed cookie it is handed.
 */
export function parseSignedBearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  if (authorization.slice(0, 7).toLowerCase() !== BEARER_SCHEME) return null;
  const token = authorization.slice(7).trim();
  if (!token.includes(".")) return null;
  return token.includes("%") ? tryDecode(token) : token;
}

/**
 * The session a before-hook has to act on: the one the ENDPOINT will see.
 *
 * better-auth runs every before-hook with the original, unmodified request
 * context (dispatch.mjs runBeforeHooks) and applies what bearer() returned,
 * the session cookie it builds from Authorization, only to the endpoint's own
 * context once all hooks have finished. A hook registered after bearer() that
 * calls getSessionFromCtx(ctx) therefore sees Authorization but no session
 * for a bearer-authenticated client, and returns without acting. This builds
 * that same cookie for the lookup instead.
 *
 * Authorization takes precedence over any Cookie header, exactly as bearer()
 * does (setRequestCookie replaces the session cookie): checking a cookie
 * session while the endpoint then acts on the bearer's would let a request
 * carry its own valid cookie and DPoP key next to somebody else's bearer.
 * When the bearer does not resolve to a session (unsigned, tampered or
 * expired), bearer() would have contributed nothing for it, so the request's
 * own cookie, if any, is what the endpoint sees and what this falls back to.
 *
 * getSessionFromCtx caches its result on the per-request context that the
 * hooks share with the endpoint, so the endpoint reuses this session and no
 * second lookup happens.
 */
export async function getSessionForHook(ctx: HookContext): ReturnType<typeof getSessionFromCtx> {
  const authorization = ctx.request?.headers.get("authorization") || ctx.headers?.get("authorization");
  const token = parseSignedBearerToken(authorization);
  const original = ctx.request?.headers || ctx.headers;
  if (token !== null && original !== undefined) {
    const headers = new Headers(original);
    setRequestCookie(headers, ctx.context.authCookies.sessionToken.name, token);
    const session = await getSessionFromCtx({ ...ctx, headers });
    if (session !== null) return session;
  }
  return getSessionFromCtx(ctx);
}

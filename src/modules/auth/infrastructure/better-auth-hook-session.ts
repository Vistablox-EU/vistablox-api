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
 * When the bearer does not resolve to a live session, this falls back to the
 * request's own cookie, if any. That is exact for an unsigned or tampered
 * bearer; bearer() only checks the HMAC, so a validly signed bearer for a dead
 * session still replaces the cookie at the endpoint, where the request is then
 * anonymous. The only effect of the difference is a DPoP check on the
 * requester's own cookie session, never on another one.
 *
 * A session that is already past its limit, or unknown, is left alone here:
 * better-auth's full session lookup ends an expired session as a side effect,
 * and the endpoint (and the device-session-lifetime plugin's REAUTH_REQUIRED
 * answer, which reads the expired row from the request context) has to meet
 * it as it is. Nothing is enforced on a session that cannot authenticate the
 * request anyway; a hook that resolved it first would turn that answer into an
 * anonymous one. The endpoints that act on the token directly (sign-out,
 * get-session) therefore still remove such an expired row without a proof,
 * which cannot hurt: it authenticates nothing.
 *
 * getSessionFromCtx caches its result on the per-request context. Endpoints
 * behind better-auth's session middleware reuse it; get-session and sign-out
 * read the credentials again themselves.
 *
 * The lookup runs before the DPoP decision, so it also refreshes a rolling
 * (non-device) session that the decision then rejects. /v1 resolves the session
 * before it checks the proof in the same way.
 */
export async function getSessionForHook(ctx: HookContext): ReturnType<typeof getSessionFromCtx> {
  const authorization = ctx.request?.headers.get("authorization") || ctx.headers?.get("authorization");
  const token = parseSignedBearerToken(authorization);
  const original = ctx.request?.headers || ctx.headers;
  if (token !== null && original !== undefined && (await isLiveSession(ctx, token))) {
    const headers = new Headers(original);
    setRequestCookie(headers, ctx.context.authCookies.sessionToken.name, token);
    const session = await getSessionFromCtx({ ...ctx, headers });
    if (session !== null) return session;
  }
  return getSessionFromCtx(ctx);
}

/**
 * Whether the signed token names a session row that has not expired, read
 * without any of getSession's side effects (it deletes an expired session and
 * may refresh a live one). The row comes through the internal adapter's
 * findSession, which the device-session-lifetime plugin wraps, so a device
 * session past its idle or absolute limit already reads as expired. The
 * signature is not checked: a wrong one finds nothing worth acting on, and the
 * lookup that follows verifies it.
 */
async function isLiveSession(ctx: HookContext, signedToken: string): Promise<boolean> {
  const separator = signedToken.lastIndexOf(".");
  if (separator < 1) return false;
  const found = await ctx.context.internalAdapter.findSession(signedToken.slice(0, separator));
  return found !== null && found.session.expiresAt.getTime() >= Date.now();
}

// Which /api/auth/* paths stay off the wire, and which request paths are
// plain enough to be judged at all.
//
// Better Auth does not route on the request target as it arrives. Its node
// adapter builds a URL from it, and its router routes on that URL's pathname
// (`new URL(request.url).pathname`). The URL standard rewrites a path on the
// way in: "." and ".." segments are resolved, also when written %2e, %2E,
// .%2e or %2e., and "\" becomes "/". Matching the raw target against a list
// can therefore describe a different endpoint from the one that is reached
// (/api/auth/x/%2e%2e/passkey/delete-passkey is routed as
// /api/auth/passkey/delete-passkey). Two checks close that, and they live in
// one file so they cannot drift apart:
//
//  - isCanonicalAuthPath: the Express guard refuses any raw path that URL
//    parsing could change or that a router might read differently, instead of
//    predicting what each parser would make of it;
//  - isDisabledAuthPath: matches a path that is already in canonical form.
//    The guard applies it to the raw path it has just accepted, and a Better
//    Auth plugin applies it to the pathname Better Auth's own router is about
//    to use, which does not depend on what the guard saw.

export const AUTH_BASE_PATH = "/api/auth";

// RFC 3986 unreserved characters only. A path made of nothing else is left
// exactly as written by URL parsing and by both routers. A percent sign is
// not among them, so an encoded dot, slash or backslash (%2e, %2f, %5c) and a
// double encoding (%252e) never qualify; neither does a backslash, a ';' path
// parameter or a non-ASCII character.
const CANONICAL_SEGMENT = /^[A-Za-z0-9._~-]+$/;
// "." and ".." are dot segments that URL parsing removes; a longer run of
// dots is not one, but nothing routed here is named that, so it is refused too.
const DOTS_ONLY = /^\.+$/;

// The credential email and passkey-delete rules below tolerate any number of
// trailing slashes, as Better Auth's own normalizePathname strips them all.
// The email-otp rule is a prefix match, so it needs no such allowance.
const CREDENTIAL_EMAIL_PATH = /^\/api\/auth\/(?:sign-in|sign-up)\/email\/*$/;
const EMAIL_OTP_PATH = /^\/api\/auth\/(?:email-otp|sign-in\/email-otp)(?:\/|$)/;
// Passkey replacement only ever happens via account recovery and staff
// recovery's bootstrap flow (issuePasskeyBootstrap -> registration's
// afterVerification deleting the prior credential directly through the
// adapter) -- the passkey plugin's own generic delete-passkey endpoint is a
// second, unguarded path to the same destructive action for any signed-in
// user, bypassing that flow entirely. update-passkey (rename only) stays
// open; there's no equivalent risk in renaming a label.
const PASSKEY_DELETE_PATH = /^\/api\/auth\/passkey\/delete-passkey\/*$/;
// @better-auth/expo's browser-OAuth helper. It needs no session and returns a
// value of the caller's choosing signed with the same secret and format as the
// session cookie, which would let anyone who holds a bare session token turn it
// into a signed bearer and defeat bearer({ requireSignature: true }). The app
// exchanges native ID tokens and never opens this flow.
const EXPO_AUTHORIZATION_PROXY_PATH = /^\/api\/auth\/expo-authorization-proxy\/*$/;

/**
 * True when `pathname` (a request target up to its `?` or `#`) is a path
 * under /api/auth that no parser changes or reads differently: the lower-case
 * base path, then one or more non-empty segments of unreserved characters
 * separated by single slashes, none of them a run of dots, with no trailing
 * slash. Every route Better Auth registers in this configuration is of this
 * form (tests/better-auth-disabled-routes.test.ts checks the live route
 * table); anything else is a route it does not serve or an encoding trick.
 */
export function isCanonicalAuthPath(pathname: string): boolean {
  const prefix = `${AUTH_BASE_PATH}/`;
  if (!pathname.startsWith(prefix)) return false;
  return pathname
    .slice(prefix.length)
    .split("/")
    .every((segment) => CANONICAL_SEGMENT.test(segment) && !DOTS_ONLY.test(segment));
}

/**
 * True for the credential, email-code and passkey-deletion endpoints that are
 * kept off the wire. `pathname` must already be a canonical path, or the
 * pathname Better Auth's router is about to use; matching is case-insensitive
 * and tolerates trailing slashes.
 */
export function isDisabledAuthPath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return (
    path.includes("password") ||
    CREDENTIAL_EMAIL_PATH.test(path) ||
    EMAIL_OTP_PATH.test(path) ||
    PASSKEY_DELETE_PATH.test(path) ||
    EXPO_AUTHORIZATION_PROXY_PATH.test(path)
  );
}

/**
 * The Express guard's whole decision: a raw request path (up to its `?` or
 * `#`) may be passed on to Better Auth only if it is canonical and not
 * disabled.
 */
export function isAuthPathAllowed(rawPathname: string): boolean {
  return isCanonicalAuthPath(rawPathname) && !isDisabledAuthPath(rawPathname);
}

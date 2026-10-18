import { describe, expect, it } from "vitest";

import {
  isAuthPathAllowed,
  isCanonicalAuthPath,
  isDisabledAuthPath,
} from "../src/modules/auth/domain/disabled-auth-routes.js";

describe("isCanonicalAuthPath", () => {
  it.each([
    "/api/auth/get-session",
    "/api/auth/sign-in/social",
    "/api/auth/callback/google",
    "/api/auth/passkey/delete-passkey",
    "/api/auth/device/enrol/verify",
    "/api/auth/a.b/c_d/e~f",
    "/api/auth/Callback/Provider1",
    "/api/auth/0",
    "/api/auth/.well-known",
    "/api/auth/a..b",
    "/api/auth/a/b/c/d/e/f/g/get-session",
  ])("accepts %s", (path) => {
    expect(isCanonicalAuthPath(path)).toBe(true);
  });

  it.each([
    ["nothing after the base path", "/api/auth"],
    ["only a slash after the base path", "/api/auth/"],
    ["a different base path", "/api/other/get-session"],
    ["a base path that only starts the same way", "/api/authx/get-session"],
    ["an upper-case base path", "/API/AUTH/get-session"],
    ["a mixed-case base path", "/api/Auth/get-session"],
    ["no leading slash", "api/auth/get-session"],
    ["a leading repeated slash", "//api/auth/get-session"],
    ["an absolute URL", "http://localhost/api/auth/get-session"],
    ["a single dot segment", "/api/auth/./get-session"],
    ["a double dot segment", "/api/auth/x/../get-session"],
    ["a trailing dot segment", "/api/auth/get-session/."],
    ["a trailing double dot segment", "/api/auth/get-session/.."],
    ["a segment of three dots", "/api/auth/.../get-session"],
    ["an encoded dot", "/api/auth/%2e/get-session"],
    ["an encoded double dot", "/api/auth/x/%2e%2e/get-session"],
    ["an upper-case encoded double dot", "/api/auth/x/%2E%2E/get-session"],
    ["a half-encoded double dot", "/api/auth/x/.%2e/get-session"],
    ["the other half-encoded double dot", "/api/auth/x/%2e./get-session"],
    ["an encoded slash", "/api/auth/x%2fget-session"],
    ["an encoded backslash", "/api/auth/x%5cget-session"],
    ["a double-encoded dot", "/api/auth/x/%252e%252e/get-session"],
    ["an encoded letter", "/api/auth/get-sessio%6e"],
    ["an encoded hyphen", "/api/auth/get%2Dsession"],
    ["an encoded null byte", "/api/auth/get-session%00"],
    ["a bare percent sign", "/api/auth/get-session%"],
    ["a backslash", "/api/auth/x\\get-session"],
    ["backslash dot segments", "/api/auth/x\\..\\get-session"],
    ["a repeated slash after the base path", "/api/auth//get-session"],
    ["a repeated slash inside the path", "/api/auth/passkey//list-user-passkeys"],
    ["a trailing slash", "/api/auth/get-session/"],
    ["repeated trailing slashes", "/api/auth/get-session//"],
    ["a path parameter", "/api/auth/get-session;jsessionid=1"],
    ["a path parameter on an inner segment", "/api/auth/x;a=b/get-session"],
    ["a path parameter on a dot segment", "/api/auth/x/..;/get-session"],
    ["a colon", "/api/auth/a:b"],
    ["an at sign", "/api/auth/a@b"],
    ["a comma", "/api/auth/a,b"],
    ["a space", "/api/auth/get session"],
    ["a tab", "/api/auth/get\tsession"],
    ["a newline", "/api/auth/get\nsession"],
    ["a null byte", "/api/auth/get\u0000session"],
    ["a non-ASCII letter", "/api/auth/gét-session"],
    ["a full-width dot", "/api/auth/x/．．/get-session"],
    ["a query string left on the path", "/api/auth/get-session?a=b"],
    ["a fragment left on the path", "/api/auth/get-session#a"],
    ["a dot segment only after the fourth segment", "/api/auth/a/b/c/d/e/../get-session"],
    ["dot segments that climb back out of four segments", "/api/auth/a/b/c/d/../../../../passkey/delete-passkey"],
    ["encoded dot segments only after the fourth segment", "/api/auth/a/b/c/d/e/%2e%2e/%2e%2e/get-session"],
    ["a backslash only after the fourth segment", "/api/auth/a/b/c/d/e\\get-session"],
    ["a path parameter only after the fourth segment", "/api/auth/a/b/c/d/e;x/get-session"],
    ["a trailing slash after a deep path", "/api/auth/a/b/c/d/e/f/"],
    ["a repeated slash only after the fourth segment", "/api/auth/a/b/c/d/e//f"],
  ])("refuses %s", (_name, path) => {
    expect(isCanonicalAuthPath(path)).toBe(false);
  });

  // The accepted alphabet is part of the contract ("a path URL parsing leaves
  // exactly as written"), so it is pinned character by character against the
  // URL parser itself, rather than by the handful of characters the tables
  // above happen to mention. Every UTF-16 code unit is tried at the start, in
  // the middle and at the end of a segment. A character the parser rewrites
  // ('"', '<', '>', '`', '{', '}', DEL, and '%' and '\\' which it
  // reinterprets) must never be accepted; and because widening the class even
  // by a character the parser leaves alone ('!', '$', '*', ':' ...) changes
  // what Better Auth is allowed to be asked, that has to be a deliberate edit
  // of this test as well.
  describe("the characters a segment may hold", () => {
    const UNRESERVED = /^[A-Za-z0-9._~-]$/;
    const SHAPES: Array<[string, (character: string) => string]> = [
      ["at the start of a segment", (c) => `/api/auth/${c}ab`],
      ["in the middle of a segment", (c) => `/api/auth/a${c}b`],
      ["at the end of a segment", (c) => `/api/auth/ab${c}`],
      ["in an inner segment", (c) => `/api/auth/a/b${c}b/c`],
    ];

    it.each(SHAPES)("accepts exactly the RFC 3986 unreserved characters %s", (_name, shape) => {
      const wrong: string[] = [];
      let accepted = 0;
      for (let unit = 0; unit <= 0xffff; unit += 1) {
        // "/" is the separator, not a character of a segment: "a/b" is two
        // segments, and is rightly accepted.
        if (unit === 0x2f) continue;
        const character = String.fromCharCode(unit);
        const canonical = isCanonicalAuthPath(shape(character));
        if (canonical) accepted += 1;
        if (canonical !== UNRESERVED.test(character)) {
          wrong.push(`U+${unit.toString(16).padStart(4, "0")} ${canonical ? "accepted" : "refused"}`);
        }
      }

      expect(wrong.slice(0, 10)).toEqual([]);
      // Not vacuous: letters, digits and . _ ~ - were tried and accepted.
      expect(accepted).toBe(26 + 26 + 10 + 4);
    });

    it.each(SHAPES)("never accepts a character the URL parser rewrites %s", (_name, shape) => {
      const rewritten: string[] = [];
      let rewrittenByTheParser = 0;
      for (let unit = 0; unit <= 0xffff; unit += 1) {
        const path = shape(String.fromCharCode(unit));
        let routed: string | undefined;
        try {
          routed = new URL(`http://host${path}`).pathname;
        } catch {
          routed = undefined;
        }
        if (routed === path) continue;
        rewrittenByTheParser += 1;
        if (isCanonicalAuthPath(path)) rewritten.push(`U+${unit.toString(16).padStart(4, "0")}`);
      }

      expect(rewritten.slice(0, 10)).toEqual([]);
      // Not vacuous: the parser rewrites or refuses a large share of them.
      expect(rewrittenByTheParser).toBeGreaterThan(1000);
    });
  });
});

describe("isDisabledAuthPath", () => {
  it.each([
    "/api/auth/passkey/delete-passkey",
    "/api/auth/passkey/delete-passkey/",
    "/api/auth/passkey/delete-passkey//",
    "/api/auth/Passkey/Delete-Passkey",
    "/api/auth/expo-authorization-proxy",
    "/api/auth/expo-authorization-proxy//",
    "/api/auth/Expo-Authorization-Proxy",
    "/api/auth/sign-in/email",
    "/api/auth/sign-in/email/",
    "/api/auth/sign-in/email//",
    "/api/auth/sign-in/email///",
    "/api/auth/sign-up/email",
    "/api/auth/sign-up/email//",
    "/api/auth/SIGN-UP/EMAIL",
    "/api/auth/email-otp",
    "/api/auth/email-otp/send-verification-otp",
    "/api/auth/sign-in/email-otp",
    "/api/auth/change-password",
    "/api/auth/verify-password",
    "/api/auth/request-password-reset",
    "/api/auth/reset-password",
    "/api/auth/reset-password/some-token",
    "/api/auth/Reset-PASSWORD",
    "/api/auth/anything-with-password-in-it",
  ])("disables %s", (path) => {
    expect(isDisabledAuthPath(path)).toBe(true);
  });

  it.each([
    "/api/auth/get-session",
    "/api/auth/sign-in/social",
    "/api/auth/passkey/update-passkey",
    "/api/auth/passkey/list-user-passkeys",
    "/api/auth/passkey/generate-register-options",
    "/api/auth/passkey/verify-registration",
    "/api/auth/callback/google",
    "/api/auth/sign-in/emails",
    "/api/auth/passkey/delete-passkeys",
    "/api/auth/passkey/delete-passkey/extra",
    "/api/auth/email-otpx",
  ])("leaves %s open", (path) => {
    expect(isDisabledAuthPath(path)).toBe(false);
  });
});

describe("isAuthPathAllowed", () => {
  it("passes a canonical path that is not disabled", () => {
    expect(isAuthPathAllowed("/api/auth/get-session")).toBe(true);
  });

  it("refuses a disabled path even though it is canonical", () => {
    expect(isCanonicalAuthPath("/api/auth/passkey/delete-passkey")).toBe(true);
    expect(isAuthPathAllowed("/api/auth/passkey/delete-passkey")).toBe(false);
  });

  it("refuses a path that is not canonical even though it names nothing disabled", () => {
    expect(isDisabledAuthPath("/api/auth/x/../get-session")).toBe(false);
    expect(isAuthPathAllowed("/api/auth/x/../get-session")).toBe(false);
  });
});

// The two properties the guard stands on, checked against the URL parser
// itself over every combination of the spellings an attacker has for a dot
// segment, a separator and the disabled endpoints -- not over a hand-picked
// list. Better Auth routes on `new URL(request.url).pathname`.
describe("agreement with the URL standard's path normalisation", () => {
  const SEGMENT_SPELLINGS = [
    "",
    "x",
    "passkey",
    "delete-passkey",
    "verify-password",
    ".",
    "..",
    "%2e%2e",
    ".%2e",
    "%2E.",
    "x;a=b",
    "x%2fy",
    "%252e",
  ];
  const SEPARATORS = ["/", "\\"];

  function* candidates(): Generator<string> {
    // /api/auth + up to four segments, every spelling in every position, with
    // either separator before each segment.
    function* extend(prefix: string, depth: number): Generator<string> {
      yield prefix;
      if (depth === 4) return;
      for (const separator of SEPARATORS) {
        for (const segment of SEGMENT_SPELLINGS) {
          yield* extend(`${prefix}${separator}${segment}`, depth + 1);
        }
      }
    }
    yield* extend("/api/auth", 0);
  }

  const routedPath = (target: string) => new URL(`http://host${target}`).pathname;

  it("never calls a path canonical unless URL parsing leaves it exactly as written", () => {
    const changed: string[] = [];
    let canonical = 0;
    for (const target of candidates()) {
      if (!isCanonicalAuthPath(target)) continue;
      canonical += 1;
      if (routedPath(target) !== target) changed.push(target);
    }

    expect(changed.slice(0, 10)).toEqual([]);
    // Not vacuous: some of the candidates are canonical.
    expect(canonical).toBeGreaterThan(100);
  });

  it("never lets through a path that URL parsing turns into a disabled one", () => {
    const leaked: string[] = [];
    let routedToDisabled = 0;
    let routedToDisabledAfterRewrite = 0;
    for (const target of candidates()) {
      const routed = routedPath(target);
      if (!isDisabledAuthPath(routed)) continue;
      routedToDisabled += 1;
      if (routed !== target) routedToDisabledAfterRewrite += 1;
      if (isAuthPathAllowed(target)) leaked.push(`${target} -> ${routed}`);
    }

    expect(leaked.slice(0, 10)).toEqual([]);
    // Not vacuous: plenty of candidates reach a disabled route, and many of
    // those only after the parser rewrote them.
    expect(routedToDisabled).toBeGreaterThan(1000);
    expect(routedToDisabledAfterRewrite).toBeGreaterThan(1000);
  });

  // The generator above stops at four segments to keep the number of paths
  // manageable. Nothing in the policy is about a segment's position, so the
  // same two properties are checked again on much deeper paths over a smaller
  // alphabet of the spellings that matter.
  describe("on paths up to eight segments deep", () => {
    const DEEP_SPELLINGS = ["x", "passkey", "delete-passkey", "..", "%2e%2e"];

    function* deepCandidates(): Generator<string> {
      function* extend(prefix: string, depth: number): Generator<string> {
        yield prefix;
        if (depth === 8) return;
        for (const segment of DEEP_SPELLINGS) yield* extend(`${prefix}/${segment}`, depth + 1);
      }
      yield* extend("/api/auth", 0);
    }

    it("never calls a path canonical unless URL parsing leaves it exactly as written", () => {
      const changed: string[] = [];
      let canonical = 0;
      let deepCanonical = 0;
      for (const target of deepCandidates()) {
        if (!isCanonicalAuthPath(target)) continue;
        canonical += 1;
        if (target.split("/").length > 7) deepCanonical += 1;
        if (routedPath(target) !== target) changed.push(target);
      }

      expect(changed.slice(0, 10)).toEqual([]);
      // Not vacuous: canonical paths exist, and some of them are deeper than
      // the four segments the generator above reaches.
      expect(canonical).toBeGreaterThan(100);
      expect(deepCanonical).toBeGreaterThan(100);
    });

    it("never lets through a path that URL parsing turns into a disabled one", () => {
      const leaked: string[] = [];
      let routedToDisabled = 0;
      let routedToDisabledAfterRewrite = 0;
      let deepRewritten = 0;
      for (const target of deepCandidates()) {
        const routed = routedPath(target);
        if (!isDisabledAuthPath(routed)) continue;
        routedToDisabled += 1;
        if (routed !== target) {
          routedToDisabledAfterRewrite += 1;
          // Rewritten by dot segments that only start after the fourth segment.
          if (target.split("/").slice(0, 7).every((segment) => segment !== ".." && segment !== "%2e%2e")) {
            deepRewritten += 1;
          }
        }
        if (isAuthPathAllowed(target)) leaked.push(`${target} -> ${routed}`);
      }

      expect(leaked.slice(0, 10)).toEqual([]);
      expect(routedToDisabled).toBeGreaterThan(1000);
      expect(routedToDisabledAfterRewrite).toBeGreaterThan(1000);
      expect(deepRewritten).toBeGreaterThan(100);
    });
  });
});

import http from "node:http";
import type { AddressInfo } from "node:net";

import express, { type Request, type Response } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { rejectDisabledAuthRoutes } from "../src/modules/auth/api/shared/reject-disabled-auth.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

function buildApp() {
  const app = express();
  app.use(requestContext);
  // Mirrors app.ts's actual mounting exactly (app.all with a wildcard route
  // pattern, not app.use(prefix, ...)) -- req.url only holds the full
  // /api/auth/... path under the former; app.use's mount-relative stripping
  // would make the guard refuse every request.
  app.all(
    "/api/auth/*splat",
    rejectDisabledAuthRoutes,
    (_request, response) => response.json({ ok: true }),
  );
  app.use(errorHandler);
  return app;
}

describe("reject disabled auth routes", () => {
  it("404s the generic passkey delete endpoint", async () => {
    const response = await request(buildApp()).post("/api/auth/passkey/delete-passkey");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "resource.not_found", status: 404 });
  });

  it("404s the generic passkey delete endpoint with a trailing slash", async () => {
    const response = await request(buildApp()).post("/api/auth/passkey/delete-passkey/");

    expect(response.status).toBe(404);
  });

  it("404s the expo authorization proxy, which signs caller-chosen values with the session secret", async () => {
    for (const path of ["/api/auth/expo-authorization-proxy", "/api/auth/expo-authorization-proxy/", "/api/auth/Expo-Authorization-Proxy"]) {
      const response = await request(buildApp()).get(path);

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: "resource.not_found", status: 404 });
    }
  });

  it("leaves update-passkey (rename) open", async () => {
    const response = await request(buildApp()).post("/api/auth/passkey/update-passkey");

    expect(response.status).toBe(200);
  });

  it("leaves the passkey endpoints the mobile app actually uses open", async () => {
    const openPaths = [
      "/api/auth/passkey/list-user-passkeys",
      "/api/auth/passkey/generate-authenticate-options",
      "/api/auth/passkey/verify-authentication",
      "/api/auth/passkey/generate-register-options",
      "/api/auth/passkey/verify-registration",
    ];

    for (const path of openPaths) {
      const response = await request(buildApp()).post(path);
      expect(response.status).toBe(200);
    }
  });

  it("still 404s disabled credential/email-code routes (pre-existing behavior)", async () => {
    const response = await request(buildApp()).post("/api/auth/sign-in/email");

    expect(response.status).toBe(404);
  });
});

// Better Auth does not route on the request target as sent: it builds a URL
// from it and routes on `new URL(...).pathname`, which resolves dot segments
// (also when percent-encoded) and turns backslashes into slashes. The cases
// above go through supertest, whose client may tidy a path before it is sent;
// node:http puts `path` on the request line as given, so these reach the guard
// exactly as an attacker would write them.
//
// The guard is mounted with app.all, so it must refuse whatever the HTTP
// method: every table below runs once per method. The stub handler records
// every target it is given, so "the guard refused it" means "the handler was
// never called", not merely "the status was 404".
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

describe("reject disabled auth routes: request targets Better Auth would normalise", () => {
  let server: http.Server;
  let port: number;
  let reached: string[];

  beforeAll(async () => {
    const app = express();
    app.use(requestContext);
    app.all("/api/auth/*splat", rejectDisabledAuthRoutes, (incoming, response) => {
      reached.push(incoming.url);
      response.json({ ok: true });
    });
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  beforeEach(() => {
    reached = [];
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function sendRaw(target: string, method: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const outgoing = http.request({ host: "127.0.0.1", port, method, path: target }, (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
  }

  /** A HEAD response has no body, so only the status can be checked for it. */
  function expectRefused(response: { status: number; body: string }, method: string): void {
    expect(response.status).toBe(404);
    if (method !== "HEAD") {
      expect(JSON.parse(response.body)).toMatchObject({ code: "resource.not_found", status: 404 });
    }
    expect(reached).toEqual([]);
  }

  // Not all of these are routed by Better Auth (it does not percent-decode,
  // and 404s repeated and trailing slashes itself). The guard does not try to
  // work out which: a path whose meaning depends on the parser is refused.
  // Several are deeper than four segments, so a check that only looked at the
  // first few segments of a path would let them through.
  const AMBIGUOUS_TARGETS: Array<[string, string]> = [
    ["a dot segment", "/api/auth/x/../get-session"],
    ["a dot segment onto the passkey delete route", "/api/auth/x/../passkey/delete-passkey"],
    ["a single dot segment", "/api/auth/./get-session"],
    ["a trailing dot segment", "/api/auth/get-session/."],
    ["a trailing double dot segment", "/api/auth/get-session/.."],
    ["a segment of three dots", "/api/auth/.../get-session"],
    ["an encoded double dot segment", "/api/auth/x/%2e%2e/get-session"],
    ["an upper-case encoded double dot segment", "/api/auth/x/%2E%2E/get-session"],
    ["a half-encoded double dot segment", "/api/auth/x/.%2e/get-session"],
    ["the other half-encoded double dot segment", "/api/auth/x/%2e./get-session"],
    ["an encoded single dot segment", "/api/auth/%2e/get-session"],
    ["an encoded dot segment onto the passkey delete route", "/api/auth/x/%2e%2e/passkey/delete-passkey"],
    ["an encoded dot segment after the passkey delete route", "/api/auth/passkey/delete-passkey/%2e%2e/delete-passkey"],
    ["an encoded slash", "/api/auth/x%2fget-session"],
    ["an upper-case encoded slash", "/api/auth/x%2Fget-session"],
    ["an encoded slash after dot segments", "/api/auth/x/..%2fget-session"],
    ["an encoded backslash", "/api/auth/x%5cget-session"],
    ["a double-encoded dot", "/api/auth/x/%252e%252e/get-session"],
    ["a double-encoded slash", "/api/auth/x%252fget-session"],
    ["an encoded hyphen", "/api/auth/get%2Dsession"],
    ["an encoded letter", "/api/auth/get-sessio%6e"],
    ["an encoded null byte", "/api/auth/get-session%00"],
    ["a backslash", "/api/auth/x\\get-session"],
    ["backslash dot segments", "/api/auth/x\\..\\get-session"],
    ["backslash dot segments onto the passkey delete route", "/api/auth/x\\..\\passkey\\delete-passkey"],
    ["a repeated slash after the base path", "/api/auth//get-session"],
    ["a repeated slash inside the path", "/api/auth/passkey//list-user-passkeys"],
    ["a trailing slash", "/api/auth/get-session/"],
    ["repeated trailing slashes", "/api/auth/get-session//"],
    ["an upper-case base path", "/API/AUTH/get-session"],
    ["a mixed-case base path", "/Api/Auth/get-session"],
    ["a path parameter on the last segment", "/api/auth/get-session;jsessionid=1"],
    ["a path parameter on an inner segment", "/api/auth/x;a=b/get-session"],
    ["a path parameter on a dot segment", "/api/auth/x/..;/get-session"],
    ["an absolute-form request target", "http://127.0.0.1/api/auth/get-session"],
    ["dot segments five segments deep onto the passkey delete route", "/api/auth/a/b/c/d/../../../../passkey/delete-passkey"],
    ["encoded dot segments six segments deep onto the passkey delete route", "/api/auth/a/b/c/d/e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/passkey/delete-passkey"],
    ["a dot segment only after the fourth segment", "/api/auth/a/b/c/d/e/../get-session"],
    ["a backslash only after the fourth segment", "/api/auth/a/b/c/d/e\\get-session"],
    ["an encoded slash only after the fourth segment", "/api/auth/a/b/c/d/e%2fget-session"],
    ["a path parameter only after the fourth segment", "/api/auth/a/b/c/d/e;x/get-session"],
  ];

  const DISABLED_TARGETS: Array<[string, string]> = [
    ["the passkey delete route", "/api/auth/passkey/delete-passkey"],
    ["the passkey delete route with a query string", "/api/auth/passkey/delete-passkey?a=b"],
    ["the passkey delete route with a fragment", "/api/auth/passkey/delete-passkey#fragment"],
    ["the passkey delete route in other case", "/api/auth/Passkey/Delete-Passkey"],
    ["the expo authorization proxy", "/api/auth/expo-authorization-proxy"],
    ["the expo authorization proxy with trailing slashes", "/api/auth/expo-authorization-proxy//"],
    ["the expo authorization proxy in other case", "/api/auth/Expo-Authorization-Proxy"],
    ["a password route", "/api/auth/verify-password"],
    ["a password route in other case", "/api/auth/Verify-PassWord"],
    ["the reset-password token route", "/api/auth/reset-password/some-token"],
    ["the credential sign-in route", "/api/auth/sign-in/email"],
    ["the credential sign-up route", "/api/auth/sign-up/email"],
    ["an email-otp route", "/api/auth/email-otp/send-verification-otp"],
    ["the email-otp sign-in route", "/api/auth/sign-in/email-otp"],
  ];

  // Every shape Better Auth is actually called with: plain lower-case
  // segments, a provider name as a parameter, dots inside a name, and
  // anything at all after the `?`.
  const ALLOWED_TARGETS: Array<[string, string]> = [
    ["a plain route", "/api/auth/get-session"],
    ["a nested route", "/api/auth/sign-in/social"],
    ["a route with a parameter", "/api/auth/callback/google"],
    ["a three-segment route", "/api/auth/device/enrol/verify"],
    ["a route more than four segments deep", "/api/auth/a/b/c/d/e/f/get-session"],
    ["update-passkey", "/api/auth/passkey/update-passkey"],
    ["a dot inside a segment", "/api/auth/some.route/under_score/til~de"],
    ["an upper-case parameter value", "/api/auth/callback/Provider1"],
    ["a query string with encodings", "/api/auth/callback/apple?code=a%2Fb&state=%2e%2e%2f&x=..\\"],
    ["a query string naming a disabled route", "/api/auth/get-session?next=/api/auth/passkey/delete-passkey&p=password"],
    ["an empty query string", "/api/auth/get-session?"],
    ["a fragment, which is not part of the path", "/api/auth/get-session#fragment"],
    ["a query string and a fragment", "/api/auth/get-session?a=b#c/../d"],
  ];

  describe.each(METHODS)("%s", (method) => {
    it.each(AMBIGUOUS_TARGETS)("404s %s without reaching Better Auth", async (_name, target) => {
      expectRefused(await sendRaw(target, method), method);
    });

    it.each(DISABLED_TARGETS)("404s %s without reaching Better Auth", async (_name, target) => {
      expectRefused(await sendRaw(target, method), method);
    });

    it.each(ALLOWED_TARGETS)("lets %s through", async (_name, target) => {
      const response = await sendRaw(target, method);

      expect(response.status).toBe(200);
      expect(reached).toEqual([target]);
    });
  });

  // Two targets that never get as far as the guard over HTTP/1.1; Better Auth
  // must not be reached either way, and the guard's own answer to both is
  // checked on its own in the next describe.
  it("never passes a non-ASCII character on to Better Auth: Node's HTTP parser answers 400 itself", async () => {
    const response = await sendRaw("/api/auth/gét-session", "POST");

    expect(response.status).toBe(400);
    expect(reached).toEqual([]);
  });

  it("never passes a malformed percent escape on to Better Auth: Express's param decoding fails first", async () => {
    const response = await sendRaw("/api/auth/get-session%", "POST");

    // The status is whatever the error handler makes of Express's decode
    // failure (500 today, although 400 would be more accurate); it is not
    // pinned here, only that this is an error and nothing was routed.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(reached).toEqual([]);
  });
});

// The guard on its own, handed a request target directly. Over HTTP/1.1 Node's
// HTTP parser refuses raw non-ASCII and control characters in a request line,
// Express's route matching refuses malformed percent escapes, and "*" does not
// match the route, so none of those can be driven through a server; but they
// would reach the guard if a different front end or parser let them through.
// The empty target is the same kind of odd shape. The guard must refuse them
// all itself rather than lean on what sits in front of it.
describe("reject disabled auth routes: targets refused without a server in front of the guard", () => {
  it.each([
    ["a non-ASCII character", "/api/auth/gét-session"],
    ["a non-ASCII dot lookalike", "/api/auth/x/．．/passkey/delete-passkey"],
    ["a malformed percent escape", "/api/auth/get-session%"],
    ["a percent sign followed by non-hex characters", "/api/auth/get-session%zz"],
    ["a space", "/api/auth/get session"],
    ["a tab", "/api/auth/get\tsession"],
    ["a line feed", "/api/auth/get\nsession"],
    ["a null byte", "/api/auth/get\u0000session"],
    ["a delete control character", "/api/auth/get\u007fsession"],
    ["an empty target", ""],
    ["the bare asterisk target", "*"],
  ])("answers 404 for %s", (_name, url) => {
    const next = vi.fn();

    rejectDisabledAuthRoutes({ url } as Request, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toMatchObject({ code: "resource.not_found", status: 404 });
  });

  it("calls next without an error for a plain route", () => {
    const next = vi.fn();

    rejectDisabledAuthRoutes({ url: "/api/auth/get-session?a=b" } as Request, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });
});

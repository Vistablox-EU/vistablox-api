import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

  function sendRaw(target: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const outgoing = http.request(
        { host: "127.0.0.1", port, method: "POST", path: target },
        (response) => {
          let body = "";
          response.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
  }

  // Not all of these are routed by Better Auth (it does not percent-decode,
  // and 404s repeated and trailing slashes itself). The guard does not try to
  // work out which: a path whose meaning depends on the parser is refused.
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
  ];

  it.each(AMBIGUOUS_TARGETS)("404s %s without reaching Better Auth", async (_name, target) => {
    const response = await sendRaw(target);

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ code: "resource.not_found", status: 404 });
    expect(reached).toEqual([]);
  });

  // Express decodes the path while matching the route, before any handler
  // runs, and refuses these itself; they never get as far as the guard.
  it.each([
    ["a malformed percent escape", "/api/auth/get-session%"],
    ["a non-ASCII character", "/api/auth/g\u00e9t-session"],
  ])("never passes %s on to Better Auth", async (_name, target) => {
    const response = await sendRaw(target);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(reached).toEqual([]);
  });

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

  it.each(DISABLED_TARGETS)("404s %s without reaching Better Auth", async (_name, target) => {
    const response = await sendRaw(target);

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ code: "resource.not_found", status: 404 });
    expect(reached).toEqual([]);
  });

  // Every shape Better Auth is actually called with: plain lower-case
  // segments, a provider name as a parameter, dots inside a name, and
  // anything at all after the `?`.
  const ALLOWED_TARGETS: Array<[string, string]> = [
    ["a plain route", "/api/auth/get-session"],
    ["a nested route", "/api/auth/sign-in/social"],
    ["a route with a parameter", "/api/auth/callback/google"],
    ["a three-segment route", "/api/auth/device/enrol/verify"],
    ["update-passkey", "/api/auth/passkey/update-passkey"],
    ["a dot inside a segment", "/api/auth/some.route/under_score/til~de"],
    ["an upper-case parameter value", "/api/auth/callback/Provider1"],
    ["a query string with encodings", "/api/auth/callback/apple?code=a%2Fb&state=%2e%2e%2f&x=..\\"],
    ["a query string naming a disabled route", "/api/auth/get-session?next=/api/auth/passkey/delete-passkey&p=password"],
    ["an empty query string", "/api/auth/get-session?"],
    ["a fragment, which is not part of the path", "/api/auth/get-session#fragment"],
    ["a query string and a fragment", "/api/auth/get-session?a=b#c/../d"],
  ];

  it.each(ALLOWED_TARGETS)("lets %s through", async (_name, target) => {
    const response = await sendRaw(target);

    expect(response.status).toBe(200);
    expect(reached).toEqual([target]);
  });
});

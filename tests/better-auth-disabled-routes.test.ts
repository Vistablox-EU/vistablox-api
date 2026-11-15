import http from "node:http";
import type { AddressInfo } from "node:net";

import { memoryAdapter } from "better-auth/adapters/memory";
import { toNodeHandler } from "better-auth/node";
import pino from "pino";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import {
  isAuthPathAllowed,
  isCanonicalAuthPath,
  isDisabledAuthPath,
} from "../src/modules/auth/domain/disabled-auth-routes.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/shared/better-auth.factory.js";
import { issuePasskeyBootstrap } from "../src/modules/auth/infrastructure/shared/passkey-bootstrap.js";
import { createSoftwareAuthenticator } from "./support/software-authenticator.js";

// The deny-list is only worth anything if the request it judges is the
// request Better Auth routes. Everything here runs through the real
// createApp mount, the real better-auth router and the real passkey plugin
// (on better-auth's memory adapter, so no database), and talks to it over a
// socket with node:http, which sends the request target exactly as given.
// A stub handler cannot catch a disagreement between the guard and the
// router's own URL parsing; this can, because the passkey row is really
// deleted if the router reaches the endpoint.
const API_ORIGIN = "https://api.vistablox.io";
const RP_ID = "api.vistablox.io";
const SECRET = "disabled-auth-routes-test-secret-0123456789";

type Row = Record<string, unknown>;

function cookiesFrom(response: Response): string[] {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0] ?? "");
}

async function buildStack() {
  const db: Record<string, Row[]> = {
    auth_user: [],
    auth_session: [],
    auth_account: [],
    auth_verification: [],
    passkey: [],
  };
  const auth = createBetterAuth({
    // The factory takes the production pg Pool; better-auth itself accepts
    // any adapter and nothing else in the factory touches the pool.
    database: memoryAdapter(db) as unknown as Pool,
    baseURL: API_ORIGIN,
    secret: SECRET,
    secureCookies: false,
    trustedOrigins: [API_ORIGIN],
    webauthn: { rpId: RP_ID, origins: [API_ORIGIN] },
  });
  const context = await auth.$context;
  const staff = await context.internalAdapter.createUser(
    { name: "Staff", email: "staff@example.test", emailVerified: true, population: "staff_partner" },
    { method: "internal" },
  );

  // A real passkey ceremony, so the session below is the staff_passkey
  // session a staff member holds after signing in -- all that someone with a
  // stolen session cookie has, and enough to delete the passkey if the router
  // is reached.
  const authenticator = createSoftwareAuthenticator(RP_ID);
  const bootstrap = await issuePasskeyBootstrap({
    auth,
    betterAuthUserId: staff.id,
    email: staff.email,
    displayName: "Staff",
    replaceCredentials: false,
  });
  const registerOptions = await auth.handler(
    new Request(
      `${API_ORIGIN}/api/auth/passkey/generate-register-options?context=${encodeURIComponent(bootstrap)}`,
      { headers: { origin: API_ORIGIN } },
    ),
  );
  const registerChallenge = ((await registerOptions.json()) as { challenge: string }).challenge;
  const registration = await auth.handler(
    new Request(`${API_ORIGIN}/api/auth/passkey/verify-registration`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: API_ORIGIN,
        cookie: cookiesFrom(registerOptions).join("; "),
      },
      body: JSON.stringify({ response: authenticator.register(registerChallenge, API_ORIGIN) }),
    }),
  );
  expect(registration.status).toBe(200);
  const signInOptions = await auth.handler(
    new Request(`${API_ORIGIN}/api/auth/passkey/generate-authenticate-options`, {
      headers: { origin: API_ORIGIN },
    }),
  );
  const signInChallenge = ((await signInOptions.json()) as { challenge: string }).challenge;
  const signIn = await auth.handler(
    new Request(`${API_ORIGIN}/api/auth/passkey/verify-authentication`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: API_ORIGIN,
        cookie: cookiesFrom(signInOptions).join("; "),
      },
      body: JSON.stringify({ response: authenticator.authenticate(signInChallenge, API_ORIGIN) }),
    }),
  );
  expect(signIn.status).toBe(200);
  const sessionCookie = cookiesFrom(signIn)
    .filter((cookie) => cookie.startsWith("vb.session_token="))
    .join("; ");
  expect(sessionCookie).not.toBe("");

  const passkey = db.passkey![0];
  if (passkey === undefined || typeof passkey.id !== "string") throw new Error("passkey not enrolled");
  const passkeySnapshot = { ...passkey };
  const passkeyId = passkey.id;

  const app = createApp({
    databaseProbe: { check: async () => undefined },
    offeringRepository: { listPublic: async () => [], getInvestorDetail: async () => null },
    logger: pino({ level: "silent" }),
    corsOrigins: [],
    authHandler: toNodeHandler(auth),
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    auth,
    db,
    passkeyId,
    sessionCookie,
    port,
    /** Puts the enrolled passkey back after a test in which the attacker managed to delete it. */
    restorePasskey() {
      if (!db.passkey!.some((row) => row.id === passkeyId)) db.passkey!.push({ ...passkeySnapshot });
    },
    passkeyCount: () => db.passkey!.length,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Stack = Awaited<ReturnType<typeof buildStack>>;

interface Sent {
  status: number;
  body: string;
}

/** The target goes on the request line byte for byte: node:http does not normalise `path`. */
function send(
  stack: Stack,
  options: { method: string; target: string; headers?: Record<string, string>; body?: unknown },
): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: stack.port,
        method: options.method,
        path: options.target,
        headers: {
          origin: API_ORIGIN,
          cookie: stack.sessionCookie,
          "content-type": "application/json",
          ...options.headers,
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("error", reject);
    request.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

interface DeniedEndpoint {
  method: "GET" | "POST";
  /** Path below /api/auth, the form Better Auth's router uses. */
  path: string;
  body: (passkeyId: string) => unknown;
}

// Every endpoint the deny-list exists to keep off the wire that is actually
// registered on the router in this configuration (the email-otp routes are
// not: that plugin is not installed). Each answers something other than 404
// if the request reaches it with this session, which is what makes a 404 here
// mean "never routed".
const DENIED_ENDPOINTS: DeniedEndpoint[] = [
  { method: "POST", path: "/passkey/delete-passkey", body: (id) => ({ id }) },
  { method: "POST", path: "/verify-password", body: () => ({ password: "x" }) },
  { method: "POST", path: "/change-password", body: () => ({ currentPassword: "a", newPassword: "bbbbbbbbbbbb" }) },
  { method: "POST", path: "/reset-password", body: () => ({ newPassword: "bbbbbbbbbbbb", token: "t" }) },
  { method: "POST", path: "/request-password-reset", body: () => ({ email: "staff@example.test" }) },
  { method: "POST", path: "/sign-in/email", body: () => ({ email: "staff@example.test", password: "x" }) },
  { method: "POST", path: "/sign-up/email", body: () => ({ email: "n@example.test", password: "xxxxxxxxxxxx", name: "n" }) },
  { method: "GET", path: "/reset-password/some-token", body: () => undefined },
];

interface Variant {
  name: string;
  /** The request target as written on the request line. */
  target: string;
  /**
   * True when WHATWG URL parsing -- which is what Better Auth routes on --
   * turns the target into exactly /api/auth<path>. Such a request WOULD be
   * routed to the denied endpoint if nothing stopped it. For the false
   * variants URL parsing yields some other path. The router mostly does not
   * route those either (it does not percent-decode, and 404s repeated and
   * trailing slashes), but not always: the parameter route
   * GET /reset-password/:token captures an encoded letter, a null byte or a
   * path parameter in its last segment. Either way the guard must refuse them.
   */
  routesToEndpoint: boolean;
}

function variantsOf(path: string): Variant[] {
  const segments = path.split("/").filter((segment) => segment !== "");
  const first = segments[0] ?? "";
  const last = segments[segments.length - 1] ?? "";
  const rest = segments.slice(1);
  const base = "/api/auth";
  const variants: Variant[] = [{ name: "exact path", target: `${base}${path}`, routesToEndpoint: true }];
  for (const dots of ["..", "%2e%2e", "%2E%2E", ".%2e", "%2e.", ".%2E", "%2E."]) {
    variants.push({ name: `dot segment ${dots} before the path`, target: `${base}/x/${dots}${path}`, routesToEndpoint: true });
    variants.push({ name: `dot segment ${dots} after the path`, target: `${base}${path}/${dots}/${last}`, routesToEndpoint: true });
  }
  for (const dot of [".", "%2e", "%2E"]) {
    variants.push({ name: `single dot segment ${dot}`, target: `${base}/${dot}${path}`, routesToEndpoint: true });
  }
  variants.push(
    { name: "backslashes as separators", target: `${base}/x\\..${path.replaceAll("/", "\\")}`, routesToEndpoint: true },
    { name: "query string", target: `${base}${path}?a=b`, routesToEndpoint: true },
    { name: "fragment", target: `${base}${path}#fragment`, routesToEndpoint: true },
  );
  if (rest.length > 0) {
    variants.push(
      { name: "backslash inside the path", target: `${base}/${first}\\${rest.join("\\")}`, routesToEndpoint: true },
      { name: "repeated slash inside the path", target: `${base}/${first}//${rest.join("/")}`, routesToEndpoint: false },
    );
  }
  variants.push(
    { name: "double-encoded dot segments", target: `${base}/x/%252e%252e${path}`, routesToEndpoint: false },
    { name: "encoded slash before the path", target: `${base}/x/..%2f${path.slice(1)}`, routesToEndpoint: false },
    { name: "encoded backslash before the path", target: `${base}/x/..%5c${path.slice(1)}`, routesToEndpoint: false },
    { name: "encoded dot segments joined by an encoded slash", target: `${base}/x/%2e%2e%2f${path.slice(1)}`, routesToEndpoint: false },
    { name: "an encoded letter in the last segment", target: `${base}${path.slice(0, -1)}%${last.charCodeAt(last.length - 1).toString(16)}`, routesToEndpoint: false },
    { name: "encoded hyphen", target: `${base}${path.replace("-", "%2D")}`, routesToEndpoint: false },
    { name: "encoded null byte", target: `${base}${path}%00`, routesToEndpoint: false },
    { name: "repeated slash after the base path", target: `${base}/${path}`, routesToEndpoint: false },
    { name: "trailing slash", target: `${base}${path}/`, routesToEndpoint: false },
    { name: "repeated trailing slashes", target: `${base}${path}//`, routesToEndpoint: false },
    { name: "trailing slash dot", target: `${base}${path}/.`, routesToEndpoint: false },
    { name: "upper-case path", target: `${base}${path.toUpperCase()}`, routesToEndpoint: false },
    { name: "upper-case base path", target: `/API/AUTH${path}`, routesToEndpoint: false },
    { name: "path parameter on the last segment", target: `${base}${path};jsessionid=1`, routesToEndpoint: false },
    { name: "path parameter on a dot segment", target: `${base}/x/..;${path}`, routesToEndpoint: false },
    { name: "path parameter before a dot segment", target: `${base}/x;a=b/..${path}`, routesToEndpoint: true },
  );
  return variants;
}

describe("the Better Auth deny-list against the real router", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await buildStack();
  });
  beforeEach(() => stack.restorePasskey());
  afterAll(async () => {
    await stack.close();
  });

  describe("encoded dot segments", () => {
    it("starts from the premise that URL parsing resolves what Express matched literally", () => {
      // Pins the premise of every test below with no code of ours involved:
      // the URL a request target becomes is not the string Express matched.
      expect(new URL("http://h/api/auth/x/%2e%2e/passkey/delete-passkey").pathname).toBe(
        "/api/auth/passkey/delete-passkey",
      );
      expect(new URL("http://h/api/auth/x\\..\\passkey\\delete-passkey").pathname).toBe(
        "/api/auth/passkey/delete-passkey",
      );
    });

    it("refuses an encoded dot segment in front of the passkey delete route and leaves the passkey enrolled", async () => {
      const response = await send(stack, {
        method: "POST",
        target: "/api/auth/x/%2e%2e/passkey/delete-passkey",
        body: { id: stack.passkeyId },
      });

      expect(response.status).toBe(404);
      expect(stack.passkeyCount()).toBe(1);
    });
  });

  describe.each(
    DENIED_ENDPOINTS.map((endpoint) => [`${endpoint.method} /api/auth${endpoint.path}`, endpoint] as const),
  )("%s", (_label, endpoint) => {
    it.each(variantsOf(endpoint.path).map((variant) => [variant.name, variant] as const))(
      "stays unreachable through: %s",
      async (_name, variant) => {
        // The premise: for variants flagged as routable, URL parsing really
        // does land on the denied endpoint, so the 404 below is not an
        // accident of the target being unroutable.
        const normalised = new URL(`http://host${variant.target}`).pathname;
        if (variant.routesToEndpoint) {
          expect(normalised).toBe(`/api/auth${endpoint.path}`);
        } else {
          expect(normalised).not.toBe(`/api/auth${endpoint.path}`);
        }

        const response = await send(stack, {
          method: endpoint.method,
          target: variant.target,
          body: endpoint.body(stack.passkeyId),
        });

        expect(response.status).toBe(404);
        expect(stack.passkeyCount()).toBe(1);
      },
    );
  });

  describe("the check inside Better Auth, with Express out of the picture", () => {
    // auth.handler is what toNodeHandler calls: no Express, no guard. Each
    // disabled endpoint below answers something other than 404 when this check
    // is not there, so a 404 with Better Auth's empty body is the plugin's doing.
    it.each(DENIED_ENDPOINTS.map((endpoint) => [`${endpoint.method} ${endpoint.path}`, endpoint] as const))(
      "answers %s with the router's own 404",
      async (_label, endpoint) => {
        const response = await stack.auth.handler(
          new Request(`${API_ORIGIN}/api/auth${endpoint.path}`, {
            method: endpoint.method,
            headers: { origin: API_ORIGIN, cookie: stack.sessionCookie, "content-type": "application/json" },
            ...(endpoint.method === "POST" ? { body: JSON.stringify(endpoint.body(stack.passkeyId)) } : {}),
          }),
        );

        expect(response.status).toBe(404);
        expect(await response.text()).toBe("");
        expect(stack.passkeyCount()).toBe(1);
      },
    );

    it("judges the URL the router routes on, after dot segments are resolved", async () => {
      const target = `${API_ORIGIN}/api/auth/x/%2e%2e/passkey/delete-passkey`;
      // The Request already holds the normalised URL, which is what
      // processRequest in better-call's router reads.
      expect(new Request(target).url).toBe(`${API_ORIGIN}/api/auth/passkey/delete-passkey`);

      const response = await stack.auth.handler(
        new Request(target, {
          method: "POST",
          headers: { origin: API_ORIGIN, cookie: stack.sessionCookie, "content-type": "application/json" },
          body: JSON.stringify({ id: stack.passkeyId }),
        }),
      );

      expect(response.status).toBe(404);
      expect(stack.passkeyCount()).toBe(1);
    });

    it("leaves the routes staff and customers use alone", async () => {
      const session = await stack.auth.handler(
        new Request(`${API_ORIGIN}/api/auth/get-session`, { headers: { cookie: stack.sessionCookie } }),
      );
      const list = await stack.auth.handler(
        new Request(`${API_ORIGIN}/api/auth/passkey/list-user-passkeys`, {
          headers: { cookie: stack.sessionCookie },
        }),
      );

      expect(session.status).toBe(200);
      expect(list.status).toBe(200);
    });
  });

  describe("a client choosing the URL Better Auth routes through the Host headers", () => {
    // better-call's node adapter builds the URL it routes on as
    // `${x-forwarded-proto || "http"}://${host}${req.url}` (on a plain-HTTP
    // socket), from header values the client chooses. A Host that carries a
    // path and ends in "?" turns the real request target into a query string,
    // so the router sees a path the Express layer never did. Only a check made
    // on the router's own request can see that.
    it.each([
      ["a Host header carrying the path", { host: "127.0.0.1/api/auth/passkey/delete-passkey?" }],
      ["a Host header carrying the path and a fragment", { host: "127.0.0.1/api/auth/passkey/delete-passkey#" }],
      ["an X-Forwarded-Proto header carrying the path", { "x-forwarded-proto": "http://127.0.0.1/api/auth/passkey/delete-passkey?" }],
    ])("cannot reach the passkey delete endpoint with %s", async (_name, headers) => {
      const response = await send(stack, {
        method: "POST",
        target: "/api/auth/get-session",
        headers,
        body: { id: stack.passkeyId },
      });

      expect(response.status).toBe(404);
      expect(stack.passkeyCount()).toBe(1);
    });
  });

  describe("routes that must keep working", () => {
    it("serves get-session for the signed-in staff member", async () => {
      const response = await send(stack, { method: "GET", target: "/api/auth/get-session" });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ user: { email: "staff@example.test" } });
    });

    it("serves the passkey routes staff use, and rename but not delete", async () => {
      const list = await send(stack, { method: "GET", target: "/api/auth/passkey/list-user-passkeys" });
      expect(list.status).toBe(200);
      expect(JSON.parse(list.body)).toHaveLength(1);

      const options = await send(stack, {
        method: "GET",
        target: "/api/auth/passkey/generate-authenticate-options",
      });
      expect(options.status).toBe(200);
      expect(JSON.parse(options.body)).toHaveProperty("challenge");

      const rename = await send(stack, {
        method: "POST",
        target: "/api/auth/passkey/update-passkey",
        body: { id: stack.passkeyId, name: "Renamed key" },
      });
      expect(rename.status).toBe(200);
      expect(stack.db.passkey![0]).toMatchObject({ name: "Renamed key" });
    });

    it("serves the plain health route", async () => {
      const response = await send(stack, { method: "GET", target: "/api/auth/ok" });

      expect(response.status).toBe(200);
    });

    it("does not read the query string as part of the path", async () => {
      // `password`, dot segments and encodings in a query are just data; the
      // guard judges the path only.
      const response = await send(stack, {
        method: "GET",
        target: "/api/auth/get-session?next=%2e%2e%2fpassword&x=..\\&reset-password=1#",
      });

      expect(response.status).toBe(200);
    });
  });
});

describe("the live Better Auth route table", () => {
  it("registers the disabled-routes check ahead of every other plugin", async () => {
    const auth = createBetterAuth({
      database: memoryAdapter({}) as unknown as Pool,
      baseURL: API_ORIGIN,
      secret: SECRET,
      secureCookies: false,
      trustedOrigins: [API_ORIGIN],
    });

    const plugins = (await auth.$context).options.plugins ?? [];

    expect(plugins[0]?.id).toBe("vistablox-disabled-routes");
    expect(plugins.length).toBeGreaterThan(1);
  });

  // The guard refuses every path that is not canonical, so it must never meet
  // a route Better Auth really serves in that form. The table is read from the
  // real factory, device-auth endpoints included, with the same filter
  // better-call's createRouter applies when it registers endpoints.
  async function routeTable(): Promise<string[]> {
    const auth = createBetterAuth({
      database: memoryAdapter({}) as unknown as Pool,
      baseURL: API_ORIGIN,
      secret: SECRET,
      secureCookies: false,
      trustedOrigins: [API_ORIGIN],
      webauthn: { rpId: RP_ID, origins: [API_ORIGIN] },
      deviceAuth: { accounts: {} as never, enrolDevice: {} as never, loginDevice: {} as never },
    });
    const endpoints = Object.values(auth.api) as unknown as Array<{
      path?: string;
      options?: { metadata?: { SERVER_ONLY?: boolean } };
    }>;
    return endpoints
      .filter((endpoint) => endpoint.options !== undefined && endpoint.path !== undefined)
      .filter((endpoint) => endpoint.options?.metadata?.SERVER_ONLY !== true)
      .map((endpoint) => endpoint.path as string)
      .sort();
  }

  it("holds routes, so the checks below are not vacuous", async () => {
    const routes = await routeTable();

    expect(routes.length).toBeGreaterThan(30);
    expect(routes).toContain("/passkey/delete-passkey");
    expect(routes).toContain("/device/enrol/verify");
    expect(routes).toContain("/callback/:id");
  });

  it("serves only canonical paths, so the guard passes every route that is not disabled", async () => {
    const paths = (await routeTable()).map(
      (route) => `/api/auth${route.replaceAll(/:[A-Za-z]+/g, "Sample-value_1.2~3")}`,
    );

    expect(paths.filter((path) => !isCanonicalAuthPath(path))).toEqual([]);
    expect(paths.filter((path) => !isDisabledAuthPath(path) && !isAuthPathAllowed(path))).toEqual([]);
  });

  it("disables exactly the intended routes", async () => {
    const disabled = (await routeTable()).filter((route) => isDisabledAuthPath(`/api/auth${route}`));

    // A new Better Auth route whose path happens to contain "password" shows
    // up here on purpose: decide whether it should be on the wire.
    expect(disabled).toEqual([
      "/change-password",
      "/expo-authorization-proxy",
      "/passkey/delete-passkey",
      "/request-password-reset",
      "/reset-password",
      "/reset-password/:token",
      "/sign-in/email",
      "/sign-up/email",
      "/verify-password",
    ]);
  });
});

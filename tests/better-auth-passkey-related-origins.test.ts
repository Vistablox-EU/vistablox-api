import { createHmac, randomBytes } from "node:crypto";

import { memoryAdapter } from "better-auth/adapters/memory";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { loadEnvironment, resolveWebAuthnSettings } from "../src/config/environment.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { issuePasskeyBootstrap } from "../src/modules/auth/infrastructure/passkey-bootstrap.js";
import {
  createSoftwareAuthenticator,
  type SoftwareAuthenticator,
} from "./support/software-authenticator.js";

// The main Better Auth instance serves staff passkeys and customer device
// authentication. Passkeys are staff-only, including on the API origin.
//
// Everything here runs through the real createBetterAuth + @better-auth/passkey
// plugin (on better-auth's memory adapter), configured by the same
// loadEnvironment -> resolveWebAuthnSettings path server.ts uses -- so an
// origin dropped anywhere between WEBAUTHN_ORIGIN and the plugin fails here.
const RP_ID = "api.vistablox.io";
const API_ORIGIN = "https://api.vistablox.io";
const ADMIN_ORIGIN = "https://admin.vistablox.io";
const ANDROID_ORIGIN = "android:apk-key-hash:c29mdHdhcmUtYXV0aGVudGljYXRvcg";
const SECRET = "passkey-related-origins-test-secret-0123456789";

const environment = loadEnvironment({
  NODE_ENV: "production",
  APP_ENV: "staging",
  DATABASE_URL: "postgresql://user:password@localhost:5432/vistablox",
  BETTER_AUTH_URL: API_ORIGIN,
  BETTER_AUTH_SECRET: SECRET,
  WEBAUTHN_RP_ID: RP_ID,
  WEBAUTHN_ORIGIN: `${API_ORIGIN},${ADMIN_ORIGIN}`,
  PASSKEY_ANDROID_ORIGINS: ANDROID_ORIGIN,
  AUTH_TRUSTED_ORIGINS: `${API_ORIGIN},${ADMIN_ORIGIN}`,
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "user",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "VistaBlox <no-reply@example.com>",
  DIDIT_API_KEY: "key",
  DIDIT_WORKFLOW_ID: "269214fe-77f7-4b1a-a028-b70e861d73c1",
  DIDIT_CALLBACK_URL: "https://app.vistablox.io/kyc/complete",
  DIDIT_WEBHOOK_SECRET: "a-didit-webhook-secret-value-32-chars",
  DIDIT_APPLICATION_ID: "c2237bc6-a76c-4933-b329-6c81843b45c7",
  DIDIT_ENVIRONMENT: "sandbox",
});

type Row = Record<string, unknown>;

async function setUp() {
  const db: Record<string, Row[]> = {
    auth_user: [],
    auth_session: [],
    auth_account: [],
    auth_verification: [],
    passkey: [],
  };
  const auth = createBetterAuth({
    // The factory takes the production pg Pool; better-auth itself accepts
    // any adapter, and nothing else in the factory touches the pool.
    database: memoryAdapter(db) as unknown as Pool,
    baseURL: environment.BETTER_AUTH_URL,
    secret: environment.BETTER_AUTH_SECRET,
    secureCookies: false,
    trustedOrigins: environment.AUTH_TRUSTED_ORIGINS,
    webauthn: resolveWebAuthnSettings(environment).passkey,
  });
  const context = await auth.$context;

  async function createUser(population: "customer" | "staff_partner") {
    return context.internalAdapter.createUser(
      {
        name: `${population} user`,
        email: `${population}-${randomBytes(4).toString("hex")}@example.test`,
        emailVerified: true,
        population,
      },
      { method: "internal" },
    );
  }

  // Invitation / recovery bootstrap -> generate-register-options ->
  // verify-registration, exactly as the admin console and the app do.
  async function register(
    user: { id: string; email: string; name: string },
    authenticator: SoftwareAuthenticator,
    ceremonyOrigin: string,
    customerIdentityVerified = false,
  ): Promise<Response> {
    const bootstrap = await issuePasskeyBootstrap({
      auth,
      betterAuthUserId: user.id,
      email: user.email,
      displayName: user.name,
      replaceCredentials: false,
      customerIdentityVerified,
    });
    const origin = requestOrigin(ceremonyOrigin);
    const options = await auth.handler(
      new Request(
        `${API_ORIGIN}/api/auth/passkey/generate-register-options?context=${encodeURIComponent(bootstrap)}`,
        { headers: { origin } },
      ),
    );
    if (options.status !== 200) return options;
    const { challenge } = (await options.json()) as { challenge: string };
    return auth.handler(
      new Request(`${API_ORIGIN}/api/auth/passkey/verify-registration`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          cookie: cookiesFrom(options).join("; "),
        },
        body: JSON.stringify({ response: authenticator.register(challenge, ceremonyOrigin) }),
      }),
    );
  }

  async function signIn(
    authenticator: SoftwareAuthenticator,
    ceremonyOrigin: string,
    sessionCookie?: string,
  ): Promise<Response> {
    const origin = requestOrigin(ceremonyOrigin);
    const session = sessionCookie === undefined ? [] : [sessionCookie];
    const options = await auth.handler(
      new Request(`${API_ORIGIN}/api/auth/passkey/generate-authenticate-options`, {
        headers: { origin, ...(sessionCookie === undefined ? {} : { cookie: sessionCookie }) },
      }),
    );
    expect(options.status).toBe(200);
    const { challenge } = (await options.json()) as { challenge: string };
    return auth.handler(
      new Request(`${API_ORIGIN}/api/auth/passkey/verify-authentication`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          cookie: [...cookiesFrom(options), ...session].join("; "),
        },
        body: JSON.stringify({ response: authenticator.authenticate(challenge, ceremonyOrigin) }),
      }),
    );
  }

  // A customer's passkey sign-in continues an OAuth sign-in: it needs the
  // oauth_pending session that step leaves behind. Seeded directly (with
  // the signed session cookie the browser would hold) rather than running
  // a real Google/Apple round trip.
  function seedOAuthPendingSession(userId: string): string {
    const token = randomBytes(24).toString("base64url");
    const now = new Date();
    db.auth_session!.push({
      id: `session_${randomBytes(6).toString("hex")}`,
      token,
      userId,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
      authenticationLevel: "oauth_pending",
      dpopJkt: null,
    });
    const signature = createHmac("sha256", SECRET).update(token).digest("base64");
    return `vb.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
  }

  const sessionsOf = (userId: string) => db.auth_session!.filter((row) => row.userId === userId);
  const passkeysOf = (userId: string) => db.passkey!.filter((row) => row.userId === userId);
  return { createUser, register, signIn, seedOAuthPendingSession, sessionsOf, passkeysOf };
}

describe("passkey related origins through the real better-auth passkey plugin", () => {
  it("lets a staff user register and sign in from the admin console", async () => {
    const harness = await setUp();
    const staff = await harness.createUser("staff_partner");
    const authenticator = createSoftwareAuthenticator(RP_ID);

    const registration = await harness.register(staff, authenticator, ADMIN_ORIGIN);
    expect(registration.status).toBe(200);
    expect(harness.passkeysOf(staff.id)).toHaveLength(1);

    const signIn = await harness.signIn(authenticator, ADMIN_ORIGIN);
    expect(signIn.status).toBe(200);
    expect(harness.sessionsOf(staff.id)).toEqual([
      expect.objectContaining({ authenticationLevel: "staff_passkey" }),
    ]);
  });

  it("refuses a customer passkey registration from the admin console, storing nothing", async () => {
    const harness = await setUp();
    const customer = await harness.createUser("customer");

    const response = await harness.register(
      customer,
      createSoftwareAuthenticator(RP_ID),
      ADMIN_ORIGIN,
      true,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CUSTOMER_PASSKEY_DISABLED" });
    expect(harness.passkeysOf(customer.id)).toEqual([]);
  });

  it("refuses a customer passkey registration from the API origin", async () => {
    const harness = await setUp();
    const customer = await harness.createUser("customer");
    const response = await harness.register(customer, createSoftwareAuthenticator(RP_ID), API_ORIGIN, true);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CUSTOMER_PASSKEY_DISABLED" });
    expect(harness.passkeysOf(customer.id)).toEqual([]);
  });

  it("refuses a customer passkey registration from the native Android app origin", async () => {
    const harness = await setUp();
    const customer = await harness.createUser("customer");
    const response = await harness.register(
      customer,
      createSoftwareAuthenticator(RP_ID),
      ANDROID_ORIGIN,
      true,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CUSTOMER_PASSKEY_DISABLED" });
    expect(harness.passkeysOf(customer.id)).toEqual([]);
  });
});

function cookiesFrom(response: Response): string[] {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0] ?? "");
}

// The HTTP Origin header the request itself carries. A native app's
// ceremony origin (android:apk-key-hash:...) isn't a web origin, so its
// request is sent from the API's own origin instead.
function requestOrigin(ceremonyOrigin: string): string {
  return ceremonyOrigin.startsWith("https://") ? ceremonyOrigin : API_ORIGIN;
}

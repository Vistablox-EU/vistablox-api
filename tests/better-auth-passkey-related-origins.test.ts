import { createHmac, randomBytes } from "node:crypto";

import { memoryAdapter } from "better-auth/adapters/memory";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { loadEnvironment, resolveWebAuthnSettings } from "../src/config/environment.js";
import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";
import type { AuthAuditEvent } from "../src/modules/auth/application/auth-audit-sink.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { BetterAuthStaffAccountAdministrator } from "../src/modules/auth/infrastructure/better-auth-staff-account-administrator.js";
import { BetterAuthStaffIdentityProvider } from "../src/modules/auth/infrastructure/better-auth-staff-identity.provider.js";
import { issuePasskeyBootstrap } from "../src/modules/auth/infrastructure/passkey-bootstrap.js";
import {
  createSoftwareAuthenticator,
  type SoftwareAuthenticator,
} from "./support/software-authenticator.js";

// Passkeys are staff-only since the Phase 4 direct cutover: customers sign in
// with Google/Apple and a device key, never a passkey, from any origin. Staff
// keep every passkey flow vistablox-admin uses -- invitation acceptance,
// recovery, and sign-in -- from the API's own origin and from the admin
// console, a WebAuthn related origin (#79).
//
// Everything here runs through the real createBetterAuth + @better-auth/passkey
// plugin (on better-auth's memory adapter), configured by the same
// loadEnvironment -> resolveWebAuthnSettings path server.ts uses.
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
  const audit: AuthAuditEvent[] = [];
  const factoryOptions = {
    // The factory takes the production pg Pool; better-auth itself accepts
    // any adapter, and nothing else in the factory touches the pool.
    database: memoryAdapter(db) as unknown as Pool,
    baseURL: environment.BETTER_AUTH_URL,
    secret: environment.BETTER_AUTH_SECRET,
    secureCookies: false,
    trustedOrigins: environment.AUTH_TRUSTED_ORIGINS,
    webauthn: resolveWebAuthnSettings(environment).passkey,
  };
  const auth = createBetterAuth({
    ...factoryOptions,
    authAuditSink: {
      record: async (event) => {
        audit.push(event);
      },
    },
  });
  // server.ts's staffProvisioningAuth: a second instance over the same
  // database, used by the staff identity provider to create invited staff.
  const staffProvisioningAuth = createBetterAuth({
    ...factoryOptions,
    database: memoryAdapter(db) as unknown as Pool,
    allowPopulationInput: true,
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

  // generate-register-options -> verify-registration with a bootstrap
  // context, exactly as the admin console does. A refusal at
  // generate-register-options (before the WebAuthn prompt) is returned as is.
  async function registerWithContext(
    bootstrap: string,
    authenticator: SoftwareAuthenticator,
    ceremonyOrigin: string,
  ): Promise<Response> {
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

  async function register(
    user: { id: string; email: string; name: string },
    authenticator: SoftwareAuthenticator,
    ceremonyOrigin: string,
  ): Promise<Response> {
    const bootstrap = await issuePasskeyBootstrap({
      auth,
      betterAuthUserId: user.id,
      email: user.email,
      displayName: user.name,
      replaceCredentials: false,
    });
    return registerWithContext(bootstrap, authenticator, ceremonyOrigin);
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

  // A customer Google/Apple sign-in leaves an oauth_pending session behind.
  // Seeded directly (with the signed session cookie the browser would hold)
  // rather than running a real Google/Apple round trip.
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

  // A passkey a customer registered before the cutover: registered as staff,
  // then the user is made a customer, as every pre-cutover customer was.
  async function legacyCustomerPasskey(): Promise<{ userId: string; authenticator: SoftwareAuthenticator }> {
    const user = await createUser("staff_partner");
    const authenticator = createSoftwareAuthenticator(RP_ID);
    expect((await register(user, authenticator, API_ORIGIN)).status).toBe(200);
    const row = db.auth_user!.find((candidate) => candidate.id === user.id);
    if (row === undefined) throw new Error("user row missing");
    row.population = "customer";
    return { userId: user.id, authenticator };
  }

  const userRow = (userId: string) => db.auth_user!.find((row) => row.id === userId);
  const sessionsOf = (userId: string) => db.auth_session!.filter((row) => row.userId === userId);
  const passkeysOf = (userId: string) => db.passkey!.filter((row) => row.userId === userId);
  const refusals = (code: string) =>
    audit.filter(
      (event) => event.action === "authentication.login_failed" && event.changes.failure_code === code,
    );

  return {
    auth,
    staffProvisioningAuth,
    createUser,
    register,
    registerWithContext,
    signIn,
    seedOAuthPendingSession,
    legacyCustomerPasskey,
    userRow,
    sessionsOf,
    passkeysOf,
    refusals,
  };
}

describe("staff passkeys keep working through the real better-auth passkey plugin", () => {
  it.each([
    ["the admin console", ADMIN_ORIGIN],
    ["the API's own origin", API_ORIGIN],
  ])("lets a staff user register and sign in from %s", async (_label, origin) => {
    const harness = await setUp();
    const staff = await harness.createUser("staff_partner");
    const authenticator = createSoftwareAuthenticator(RP_ID);

    const registration = await harness.register(staff, authenticator, origin);
    expect(registration.status).toBe(200);
    expect(harness.passkeysOf(staff.id)).toHaveLength(1);

    const signIn = await harness.signIn(authenticator, origin);
    expect(signIn.status).toBe(200);
    expect(harness.sessionsOf(staff.id)).toEqual([
      expect.objectContaining({ authenticationLevel: "staff_passkey" }),
    ]);
    expect(harness.refusals("PASSKEY_STAFF_ONLY")).toEqual([]);
  });

  it("accepts a staff invitation, then registers the first passkey from the admin console", async () => {
    const harness = await setUp();
    // What AcceptStaffInvitationService calls: createOrResolveInvitedStaff
    // creates the staff_partner user and returns the registration context.
    const identities = new BetterAuthStaffIdentityProvider(harness.staffProvisioningAuth);
    const invited = await identities.createOrResolveInvitedStaff({
      email: `invited-${randomBytes(4).toString("hex")}@example.test`,
      displayName: "Invited Staff",
    });
    expect(harness.userRow(invited.betterAuthUserId)).toMatchObject({ population: "staff_partner" });
    const authenticator = createSoftwareAuthenticator(RP_ID);

    const registration = await harness.registerWithContext(
      invited.passkeyRegistrationContext,
      authenticator,
      ADMIN_ORIGIN,
    );

    expect(registration.status).toBe(200);
    expect(harness.passkeysOf(invited.betterAuthUserId)).toHaveLength(1);
    expect((await harness.signIn(authenticator, ADMIN_ORIGIN)).status).toBe(200);
  });

  it("registers a replacement passkey from a staff recovery link on the admin console", async () => {
    const harness = await setUp();
    const staff = await harness.createUser("staff_partner");
    const lost = createSoftwareAuthenticator(RP_ID);
    expect((await harness.register(staff, lost, ADMIN_ORIGIN)).status).toBe(200);
    const sent: Array<{ recoveryUrl: string }> = [];
    const emailSender = {
      sendPasskeyRecoveryEmail: async (email: { recoveryUrl: string }) => void sent.push(email),
    } as unknown as EmailSender;
    const administrator = new BetterAuthStaffAccountAdministrator(harness.auth, emailSender);
    await administrator.prepareRecovery({ betterAuthUserId: staff.id, recoveryRequiredAt: new Date() });
    await administrator.sendRecoveryEmail({
      betterAuthUserId: staff.id,
      redirectTo: `${ADMIN_ORIGIN}/staff/recover-account`,
      traceId: "trace_staff_recovery",
    });
    const recoveryContext = new URL(sent[0]?.recoveryUrl ?? "").searchParams.get("context");
    const replacement = createSoftwareAuthenticator(RP_ID);

    const registration = await harness.registerWithContext(recoveryContext ?? "", replacement, ADMIN_ORIGIN);

    expect(registration.status).toBe(200);
    // The recovery context replaces the old credential and clears the hold.
    expect(harness.passkeysOf(staff.id)).toHaveLength(1);
    expect(harness.userRow(staff.id)?.recoveryRequiredAt ?? null).toBeNull();
    expect((await harness.signIn(replacement, ADMIN_ORIGIN)).status).toBe(200);
  });
});

describe("customers can't use passkeys at all, from any origin", () => {
  it.each([
    ["the API's own origin", API_ORIGIN],
    ["the admin console", ADMIN_ORIGIN],
    ["the native Android app", ANDROID_ORIGIN],
  ])("refuses a customer passkey registration from %s before the WebAuthn prompt, storing nothing", async (_label, origin) => {
    const harness = await setUp();
    const customer = await harness.createUser("customer");

    const response = await harness.register(customer, createSoftwareAuthenticator(RP_ID), origin);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PASSKEY_STAFF_ONLY" });
    expect(harness.passkeysOf(customer.id)).toEqual([]);
  });

  it.each([
    ["the API's own origin", API_ORIGIN],
    ["the admin console", ADMIN_ORIGIN],
    ["the native Android app", ANDROID_ORIGIN],
  ])("refuses a sign-in with a legacy customer passkey from %s, even mid-OAuth, creating no session", async (_label, origin) => {
    const harness = await setUp();
    const { userId, authenticator } = await harness.legacyCustomerPasskey();
    const sessionCookie = harness.seedOAuthPendingSession(userId);

    const response = await harness.signIn(authenticator, origin, sessionCookie);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PASSKEY_STAFF_ONLY" });
    // Only the seeded oauth_pending session: no passkey-assured one.
    expect(harness.sessionsOf(userId)).toEqual([
      expect.objectContaining({ authenticationLevel: "oauth_pending" }),
    ]);
    expect(harness.refusals("PASSKEY_STAFF_ONLY")).toHaveLength(1);
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

import { createHash, randomUUID, webcrypto } from "node:crypto";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins";
import { SignJWT, calculateJwkThumbprint, exportJWK, type JWK } from "jose";
import { describe, expect, it, vi } from "vitest";

import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { AuthAuditEvent } from "../src/modules/auth/application/auth-audit-sink.js";
import { DeviceLoginFailedError } from "../src/modules/auth/application/device-auth-errors.js";
import type { EnrolDeviceService } from "../src/modules/auth/application/device-enrolment.service.js";
import type { LoginDeviceService } from "../src/modules/auth/application/device-login.service.js";
import type { RecordSessionRevokedInput, SessionMirror } from "../src/modules/auth/application/session-mirror.js";
import { createBetterAuthAuditPlugin } from "../src/modules/auth/infrastructure/better-auth-audit.plugin.js";
import { createBetterAuthDeviceAuthPlugin } from "../src/modules/auth/infrastructure/better-auth-device-auth.plugin.js";
import {
  tryBindDpopAtCreation,
  type DpopCreationContext,
} from "../src/modules/auth/infrastructure/dpop-session-creation.js";
import type { Device } from "../src/modules/auth/repository/device.repository.js";

// A real better-auth instance (in-memory database, bearer tokens) with the
// real device-auth and audit plugins. Its session.create.before hook binds
// the DPoP key and marks E2/L2 sessions device_biometric the way
// better-auth.factory.ts does, so device sessions look as they do in
// production. Only the enrolment/login services and the account lookup are
// stubbed; the session mirror is a capturing fake.
const BASE_URL = "http://localhost:3000";
const ENROL_PATH = "/v1/auth/mobile/enrol/verify";
const LOGIN_PATH = "/v1/auth/mobile/login/verify";
const DEVICE_CEREMONY_PATHS = new Set(["/device/enrol/verify", "/device/login/verify"]);

type Row = Record<string, unknown> & { id: string; token: string; userId: string };

interface CeremonyApi {
  enrolVerify(input: Record<string, unknown>): Promise<unknown>;
  loginVerify(input: Record<string, unknown>): Promise<unknown>;
}

async function generateKeyPair(): Promise<{ privateKey: webcrypto.CryptoKey; publicJwk: JWK }> {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { privateKey: pair.privateKey, publicJwk: await exportJWK(pair.publicKey) };
}

// Sequential logins in a test can land in the same millisecond, and the
// survivor is the newest by (createdAt, id); a short pause keeps "later"
// meaning later.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

async function buildHarness() {
  const db: Record<string, Row[]> = { user: [], session: [], account: [], verification: [] };
  const seen = new Set<string>();
  const dpop = {
    baseUrl: BASE_URL,
    replayRepository: {
      recordProof: vi.fn(async (jkt: string, jti: string) => {
        const key = `${jkt}:${jti}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
      pruneExpired: vi.fn().mockResolvedValue(0),
    },
  };
  const dpopKeys = await generateKeyPair();
  const dpopJkt = await calculateJwkThumbprint(dpopKeys.publicJwk, "sha256");

  const device: Device = {
    deviceId: "device_supersede_1",
    accountId: "acct_supersede_1",
    betterAuthUserId: "",
    dpopJkt,
    bioJkt: "bio-jkt",
    biometricPublicJwk: {},
    platform: "android",
    status: "active",
    createdAt: new Date(),
    lastSeenAt: new Date(),
  };
  const enrolDevice = {
    execute: vi.fn(async () => device),
    rollback: vi.fn().mockResolvedValue(undefined),
  };
  const loginDevice = { execute: vi.fn(async () => device) };
  const accounts = {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({ accountId: "acct_supersede_1", status: "active" }),
  };

  const auditEvents: AuthAuditEvent[] = [];
  const mirrorRevoked: RecordSessionRevokedInput[] = [];
  const sessionMirror: SessionMirror = {
    recordCreated: vi.fn().mockResolvedValue(undefined),
    recordRevoked: vi.fn(async (input: RecordSessionRevokedInput) => void mirrorRevoked.push(input)),
    recordActivity: vi.fn().mockResolvedValue(undefined),
  };
  const log = vi.fn();
  const auth = betterAuth({
    database: memoryAdapter(db),
    baseURL: BASE_URL,
    secret: "unit-test-secret-that-is-at-least-32-characters-long",
    emailAndPassword: { enabled: false },
    logger: { log },
    session: {
      additionalFields: {
        authenticationLevel: { type: "string", required: false, input: false },
        dpopJkt: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => {
            const boundJkt = await tryBindDpopAtCreation(context as DpopCreationContext | null, dpop);
            const path = (context as { path?: string } | null)?.path;
            return {
              data: {
                ...session,
                ...(boundJkt === null ? {} : { dpopJkt: boundJkt }),
                ...(path !== undefined && DEVICE_CEREMONY_PATHS.has(path)
                  ? { authenticationLevel: "device_biometric" }
                  : {}),
              },
            };
          },
        },
      },
    },
    plugins: [
      bearer(),
      createBetterAuthDeviceAuthPlugin({
        accounts: accounts as unknown as AccountRepository,
        enrolDevice: enrolDevice as unknown as EnrolDeviceService,
        loginDevice: loginDevice as unknown as LoginDeviceService,
        dpop,
      }),
      createBetterAuthAuditPlugin({
        sink: { record: async (event: AuthAuditEvent) => void auditEvents.push(event) },
        identifierHashKey: "unit-test-audit-key",
        sessionMirror,
      }),
    ],
  });
  const context = await auth.$context;

  async function createUser(label: string) {
    return context.internalAdapter.createUser(
      { name: `Supersede ${label}`, email: `supersede-${label}-${randomUUID()}@example.test`, emailVerified: true },
      { method: "internal" },
    );
  }

  const user = await createUser("customer");
  device.betterAuthUserId = user.id;
  const pending = await context.internalAdapter.createSession(
    user.id,
    false,
    { authenticationLevel: "oauth_pending", dpopJkt },
    true,
  );

  async function proof(path: string, bearerToken?: string): Promise<string> {
    return new SignJWT({
      htm: "POST",
      htu: `${BASE_URL}${path}`,
      iat: Math.floor(Date.now() / 1000),
      jti: randomUUID(),
      ...(bearerToken === undefined
        ? {}
        : { ath: createHash("sha256").update(bearerToken, "ascii").digest("base64url") }),
    })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: dpopKeys.publicJwk as unknown as Record<string, unknown> })
      .sign(dpopKeys.privateKey);
  }

  const api = auth.api as unknown as CeremonyApi;

  async function enrol(): Promise<Response> {
    return (await api.enrolVerify({
      headers: new Headers({ authorization: `Bearer ${pending.token}`, dpop: await proof(ENROL_PATH, pending.token) }),
      body: { challenge: "enrol-challenge", jws: "enrol-jws", attestation: { platform: "android", key_attestation_chain: ["leaf"] } },
      request: new Request(`${BASE_URL}${ENROL_PATH}`, { method: "POST" }),
      asResponse: true,
    })) as Response;
  }

  async function login(): Promise<Response> {
    return (await api.loginVerify({
      headers: new Headers({ dpop: await proof(LOGIN_PATH) }),
      body: { challenge: "login-challenge", jws: "login-jws" },
      request: new Request(`${BASE_URL}${LOGIN_PATH}`, { method: "POST" }),
      asResponse: true,
    })) as Response;
  }

  /** This customer's device_biometric sessions bound to the device's DPoP key. */
  function deviceSessions(): Row[] {
    return db.session!.filter(
      (row) => row.userId === user.id && row.dpopJkt === dpopJkt && row.authenticationLevel === "device_biometric",
    );
  }

  /** session_revoked audit reasons, by the revoked session's id. */
  function revocationReasons(): Map<string, unknown> {
    return new Map(
      auditEvents
        .filter((event) => event.action === "authentication.session_revoked")
        .map((event) => [event.resourceId, event.changes.reason]),
    );
  }

  return {
    context,
    db,
    dpopJkt,
    pending,
    userId: user.id,
    createUser,
    loginDevice,
    enrol,
    login,
    deviceSessions,
    revocationReasons,
    mirrorRevoked,
    log,
  };
}

describe("a successful device ceremony supersedes the device's earlier sessions", () => {
  it("two logins leave the device exactly one live session; the first is revoked as superseded in the audit trail and the session mirror", async () => {
    const harness = await buildHarness();

    expect((await harness.login()).status).toBe(200);
    const [first] = harness.deviceSessions();
    expect(first).toBeDefined();
    await tick();
    expect((await harness.login()).status).toBe(200);

    const remaining = harness.deviceSessions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).not.toBe(first?.id);
    expect(harness.revocationReasons().get(first?.id as string)).toBe("superseded");
    expect(harness.mirrorRevoked).toEqual([
      expect.objectContaining({ betterAuthSessionId: first?.id, reason: "superseded" }),
    ]);
  });

  it("leaves the customer's web session, another device's session, a staff session and another customer's session alone", async () => {
    const harness = await buildHarness();
    const adapter = harness.context.internalAdapter;
    const web = await adapter.createSession(harness.userId);
    const otherDevice = await adapter.createSession(
      harness.userId,
      false,
      { authenticationLevel: "device_biometric", dpopJkt: "other-device-jkt" },
      true,
    );
    const staff = await harness.createUser("staff");
    const staffSession = await adapter.createSession(staff.id, false, { authenticationLevel: "staff_passkey" }, true);
    // Same DPoP key, different user: only this customer's sessions are in scope.
    const otherCustomer = await harness.createUser("other-customer");
    const otherCustomerSession = await adapter.createSession(
      otherCustomer.id,
      false,
      { authenticationLevel: "device_biometric", dpopJkt: harness.dpopJkt },
      true,
    );

    expect((await harness.login()).status).toBe(200);
    expect((await harness.login()).status).toBe(200);

    const alive = new Set(harness.db.session!.map((row) => row.token));
    for (const kept of [web, otherDevice, staffSession, otherCustomerSession, harness.pending]) {
      expect(alive.has(kept.token)).toBe(true);
    }
    expect(harness.deviceSessions()).toHaveLength(1);
  });

  it("a failed login revokes nothing: neither an early DEVICE_LOGIN_FAILED nor a failure after its own session was created", async () => {
    const harness = await buildHarness();
    expect((await harness.login()).status).toBe(200);
    const [earlier] = harness.deviceSessions();

    harness.loginDevice.execute.mockRejectedValueOnce(new DeviceLoginFailedError());
    expect((await harness.login()).status).toBe(401);
    vi.spyOn(harness.context.internalAdapter, "findUserById").mockResolvedValueOnce(null);
    expect((await harness.login()).status).toBe(500);

    expect(harness.deviceSessions().map((row) => row.id)).toEqual([earlier?.id]);
    expect([...harness.revocationReasons().values()]).not.toContain("superseded");
    expect(harness.mirrorRevoked.map((input) => input.reason)).not.toContain("superseded");
  });

  it("E2 supersedes an earlier session of the same device, and still rotates the pending session", async () => {
    const harness = await buildHarness();
    const earlier = await harness.context.internalAdapter.createSession(
      harness.userId,
      false,
      { authenticationLevel: "device_biometric", dpopJkt: harness.dpopJkt },
      true,
    );
    await tick();

    expect((await harness.enrol()).status).toBe(200);

    const reasons = harness.revocationReasons();
    expect(reasons.get(earlier.id)).toBe("superseded");
    expect(reasons.get(harness.pending.id)).toBe("rotated");
    const remaining = harness.deviceSessions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).not.toBe(earlier.id);
  });

  it("a failure revoking an earlier session is logged at error level and doesn't fail the login", async () => {
    const harness = await buildHarness();
    expect((await harness.login()).status).toBe(200);
    const [earlier] = harness.deviceSessions();
    const adapter = harness.context.internalAdapter;
    const original = adapter.deleteSession.bind(adapter);
    vi.spyOn(adapter, "deleteSession").mockImplementation(async (token: string) => {
      if (token === earlier?.token) throw new Error("delete failed");
      return original(token);
    });
    await tick();

    expect((await harness.login()).status).toBe(200);

    expect(harness.db.session!.some((row) => row.id === earlier?.id)).toBe(true);
    expect(harness.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("superseded by a device login"),
      expect.anything(),
    );
  });

  it("an unexpected error in the supersede step never fails the login or discards its session", async () => {
    const harness = await buildHarness();
    // Not an array: the supersede step throws past its own list guard.
    vi.spyOn(harness.context.internalAdapter, "listSessions").mockResolvedValueOnce(null as never);

    expect((await harness.login()).status).toBe(200);

    expect(harness.deviceSessions()).toHaveLength(1);
    expect(harness.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("failed to supersede earlier sessions after a device login"),
      expect.anything(),
    );
  });

  it("two overlapping logins from the phone leave exactly one live session, never none", async () => {
    const harness = await buildHarness();

    const responses = await Promise.all([harness.login(), harness.login()]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(harness.deviceSessions()).toHaveLength(1);
  });
});

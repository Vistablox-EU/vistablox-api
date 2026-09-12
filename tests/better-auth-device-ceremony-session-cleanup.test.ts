import { createHash, randomUUID, webcrypto } from "node:crypto";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { SignJWT, calculateJwkThumbprint, exportJWK, type JWK } from "jose";
import { describe, expect, it, vi } from "vitest";

import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { EnrolDeviceService } from "../src/modules/auth/application/device-enrolment.service.js";
import type { LoginDeviceService } from "../src/modules/auth/application/device-login.service.js";
import type { Device } from "../src/modules/auth/repository/device.repository.js";
import { createBetterAuthDeviceAuthPlugin } from "../src/modules/auth/infrastructure/better-auth-device-auth.plugin.js";
import { createBetterAuthAuditPlugin } from "../src/modules/auth/infrastructure/better-auth-audit.plugin.js";
import type { AuthAuditEvent } from "../src/modules/auth/application/auth-audit-sink.js";

// A real better-auth instance (in-memory database, bearer tokens) with the
// real device-auth plugin: only the enrolment/login services and the
// account lookup are stubbed. Failures are injected into better-auth's own
// internalAdapter after the ceremony has created its session, and the tests
// check that no live device session is left behind, that no response
// carries a session token for it, and that the original error is kept.
const BASE_URL = "http://localhost:3000";
const ENROL_PATH = "/v1/auth/mobile/enrol/verify";
const LOGIN_PATH = "/v1/auth/mobile/login/verify";

type Row = Record<string, unknown> & { token: string; userId: string };

interface CeremonyApi {
  enrolVerify(input: Record<string, unknown>): Promise<unknown>;
  loginVerify(input: Record<string, unknown>): Promise<unknown>;
}

async function generateKeyPair(): Promise<{ privateKey: webcrypto.CryptoKey; publicJwk: JWK }> {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { privateKey: pair.privateKey, publicJwk: await exportJWK(pair.publicKey) };
}

async function buildHarness() {
  const db: Record<string, Row[]> = { user: [], session: [], account: [], verification: [] };
  const seen = new Set<string>();
  const replayRepository = {
    recordProof: vi.fn(async (jkt: string, jti: string) => {
      const key = `${jkt}:${jti}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    pruneExpired: vi.fn().mockResolvedValue(0),
  };
  const dpopKeys = await generateKeyPair();
  const dpopJkt = await calculateJwkThumbprint(dpopKeys.publicJwk, "sha256");

  const device: Device = {
    deviceId: "device_cleanup_1",
    accountId: "acct_cleanup_1",
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
    findByBetterAuthUserId: vi.fn().mockResolvedValue({ accountId: "acct_cleanup_1", status: "active" }),
  };

  const auditEvents: AuthAuditEvent[] = [];
  const auth = betterAuth({
    database: memoryAdapter(db),
    baseURL: BASE_URL,
    secret: "unit-test-secret-that-is-at-least-32-characters-long",
    emailAndPassword: { enabled: false },
    session: {
      additionalFields: {
        authenticationLevel: { type: "string", required: false, input: false },
        dpopJkt: { type: "string", required: false, input: false },
      },
    },
    plugins: [
      bearer(),
      createBetterAuthDeviceAuthPlugin({
        accounts: accounts as unknown as AccountRepository,
        enrolDevice: enrolDevice as unknown as EnrolDeviceService,
        loginDevice: loginDevice as unknown as LoginDeviceService,
        dpop: { baseUrl: BASE_URL, replayRepository },
      }),
      createBetterAuthAuditPlugin({
        sink: { record: async (event: AuthAuditEvent) => void auditEvents.push(event) },
        identifierHashKey: "unit-test-audit-key",
      }),
    ],
  });
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser(
    { name: "Cleanup Test", email: `cleanup-${randomUUID()}@example.test`, emailVerified: true },
    { method: "internal" },
  );
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
      body: { device_id: device.deviceId, challenge: "login-challenge", jws: "login-jws" },
      request: new Request(`${BASE_URL}${LOGIN_PATH}`, { method: "POST" }),
      asResponse: true,
    })) as Response;
  }

  /** Sessions other than the pending Google/Apple one. */
  function ceremonySessions(): Row[] {
    return db.session!.filter((row) => row.userId === user.id && row.token !== pending.token);
  }

  /** session_revoked audit reasons, by the revoked session's id. */
  function revocationReasons(): Map<string, unknown> {
    return new Map(
      auditEvents
        .filter((event) => event.action === "authentication.session_revoked")
        .map((event) => [event.resourceId, event.changes.reason]),
    );
  }

  return { context, pending, enrolDevice, enrol, login, ceremonySessions, db, userId: user.id, revocationReasons };
}

function expectNoSessionHandedOut(response: Response): void {
  expect(response.headers.get("set-auth-token")).toBeNull();
  const setCookie = response.headers.get("set-cookie") ?? "";
  for (const cookie of setCookie.split(/,(?=\s*[^;,=\s]+=)/)) {
    if (cookie.includes("session_token=")) {
      expect(cookie.toLowerCase()).toContain("max-age=0");
    }
  }
}

describe("device ceremonies: no live session is left behind after a late failure", () => {
  it("E2 success still hands out the new session and deletes the pending one", async () => {
    const harness = await buildHarness();

    const response = await harness.enrol();

    expect(response.status).toBe(200);
    expect(response.headers.get("set-auth-token")).not.toBeNull();
    expect(harness.ceremonySessions()).toHaveLength(1);
    expect(harness.db.session!.find((row) => row.token === harness.pending.token)).toBeUndefined();
    expect(harness.enrolDevice.rollback).not.toHaveBeenCalled();
  });

  it("E2: when deleting the pending session throws after the cookie was set, the new session and the device row both go, and the original error is kept", async () => {
    const harness = await buildHarness();
    const original = harness.context.internalAdapter.deleteSession.bind(harness.context.internalAdapter);
    const failure = new Error("pending session delete failed");
    vi.spyOn(harness.context.internalAdapter, "deleteSession").mockImplementation(async (token: string) => {
      if (token === harness.pending.token) throw failure;
      return original(token);
    });

    await expect(harness.enrol()).rejects.toBe(failure);

    expect(harness.ceremonySessions()).toHaveLength(0);
    expect(harness.enrolDevice.rollback).toHaveBeenCalledWith("device_cleanup_1");
  });

  it("E2: an API error after the cookie was set returns no session token and keeps its own code", async () => {
    const harness = await buildHarness();
    const original = harness.context.internalAdapter.deleteSession.bind(harness.context.internalAdapter);
    vi.spyOn(harness.context.internalAdapter, "deleteSession").mockImplementation(async (token: string) => {
      if (token === harness.pending.token) {
        throw APIError.from("INTERNAL_SERVER_ERROR", { code: "pending_delete_failed", message: "x" });
      }
      return original(token);
    });

    const response = await harness.enrol();

    expect(response.status).toBe(500);
    expect(((await response.json()) as { code?: string }).code).toBe("pending_delete_failed");
    expectNoSessionHandedOut(response);
    expect(harness.ceremonySessions()).toHaveLength(0);
    expect(harness.enrolDevice.rollback).toHaveBeenCalledWith("device_cleanup_1");
  });

  it("audits the discarded session of a failed E2 as ceremony_failed, while a successful E2's pending session stays rotated", async () => {
    const failed = await buildHarness();
    const original = failed.context.internalAdapter.deleteSession.bind(failed.context.internalAdapter);
    vi.spyOn(failed.context.internalAdapter, "deleteSession").mockImplementation(async (token: string) => {
      if (token === failed.pending.token) throw new Error("pending session delete failed");
      return original(token);
    });
    await expect(failed.enrol()).rejects.toThrow("pending session delete failed");
    const failedReasons = [...failed.revocationReasons().values()];
    expect(failedReasons).toEqual(["ceremony_failed"]);

    const succeeded = await buildHarness();
    expect((await succeeded.enrol()).status).toBe(200);
    expect(succeeded.revocationReasons().get(succeeded.pending.id)).toBe("rotated");
  });

  it("audits the discarded session of a failed L2 as ceremony_failed", async () => {
    const harness = await buildHarness();
    vi.spyOn(harness.context.internalAdapter, "findUserById").mockResolvedValueOnce(null);

    expect((await harness.login()).status).toBe(500);

    expect([...harness.revocationReasons().values()]).toEqual(["ceremony_failed"]);
  });

  it("L2 success still hands out the new session", async () => {
    const harness = await buildHarness();

    const response = await harness.login();

    expect(response.status).toBe(200);
    expect(response.headers.get("set-auth-token")).not.toBeNull();
    expect(harness.ceremonySessions()).toHaveLength(1);
  });

  it("L2: when the user lookup fails after the session was created, the session goes and the original error is kept", async () => {
    const harness = await buildHarness();
    vi.spyOn(harness.context.internalAdapter, "findUserById").mockResolvedValueOnce(null);

    const response = await harness.login();

    expect(response.status).toBe(500);
    expect(((await response.json()) as { code?: string }).code).toBe("device.account_mapping_missing");
    expectNoSessionHandedOut(response);
    expect(harness.ceremonySessions()).toHaveLength(0);
  });

  it("L2: when the user lookup throws, the session goes and the thrown error is kept", async () => {
    const harness = await buildHarness();
    const failure = new Error("user lookup failed");
    vi.spyOn(harness.context.internalAdapter, "findUserById").mockRejectedValueOnce(failure);

    await expect(harness.login()).rejects.toBe(failure);

    expect(harness.ceremonySessions()).toHaveLength(0);
  });

  it("keeps the original error even when deleting the new session also fails", async () => {
    const harness = await buildHarness();
    const failure = new Error("user lookup failed");
    vi.spyOn(harness.context.internalAdapter, "findUserById").mockRejectedValueOnce(failure);
    vi.spyOn(harness.context.internalAdapter, "deleteSession").mockRejectedValue(new Error("cleanup failed too"));

    await expect(harness.login()).rejects.toBe(failure);
  });
});

import { createHmac } from "node:crypto";

import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";

import type { AuthAuditEvent, AuthAuditSink } from "../src/modules/auth/application/auth-audit-sink.js";
import { createBetterAuthAuditPlugin } from "../src/modules/auth/infrastructure/better-auth-audit.plugin.js";

// E2 (/device/enrol/verify) and L2 (/device/login/verify): session_created
// when the session row is written, login_succeeded only once the ceremony
// has completed (the after hook sees its success body), login_failed when
// it fails. No attestation chain, integrity token, JWS, challenge or key
// material may reach an audit payload.
const HASH_KEY = "test-audit-identifier-key";
const JWS = "eyJhbGciOiJFUzI1NiJ9.eyJwdXJwb3NlIjoibG9naW4ifQ.c2lnbmF0dXJl";
const CHALLENGE = "challenge-value-never-audited";
const CHAIN_LEAF = "MIIBleafCertificateNeverAudited";
const INTEGRITY_TOKEN = "integrity-token-never-audited";

interface DatabaseHooks {
  session: {
    create: { after(session: Record<string, unknown>, context: unknown): Promise<void> };
    delete: { after(session: Record<string, unknown>, context: unknown): Promise<void> };
  };
}

function build(findDeviceOwner?: (deviceId: string) => Promise<string | null>) {
  const events: AuthAuditEvent[] = [];
  const sink: AuthAuditSink = {
    record: vi.fn(async (event: AuthAuditEvent) => {
      events.push(event);
    }),
  };
  const onLoginMethodUsed = vi.fn().mockResolvedValue(undefined);
  const plugin = createBetterAuthAuditPlugin({
    sink,
    identifierHashKey: HASH_KEY,
    clock: () => new Date("2026-09-11T12:00:00.000Z"),
    onLoginMethodUsed,
    ...(findDeviceOwner === undefined ? {} : { findDeviceOwner }),
  });
  return { plugin, events, sink, onLoginMethodUsed };
}

async function databaseHooks(plugin: BetterAuthPlugin): Promise<DatabaseHooks> {
  const initialized = await plugin.init?.({} as never);
  return (initialized as { options: { databaseHooks: DatabaseHooks } }).options.databaseHooks;
}

async function runAfterHook(plugin: BetterAuthPlugin, context: Record<string, unknown>): Promise<void> {
  const hook = plugin.hooks?.after?.find((candidate) => candidate.matcher(context as never));
  expect(hook).toBeDefined();
  await (hook?.handler as unknown as (context: unknown) => Promise<unknown>)(context);
}

function enrolBody(): Record<string, unknown> {
  return {
    challenge: CHALLENGE,
    jws: JWS,
    attestation: { platform: "android", key_attestation_chain: [CHAIN_LEAF], integrity_token: INTEGRITY_TOKEN },
  };
}

function loginBody(deviceId: string): Record<string, unknown> {
  return { device_id: deviceId, challenge: CHALLENGE, jws: JWS };
}

function expectNoCeremonyMaterial(events: AuthAuditEvent[], extra: string[] = []): void {
  const serialized = JSON.stringify(events);
  for (const secret of [JWS, CHALLENGE, CHAIN_LEAF, INTEGRITY_TOKEN, ...extra]) {
    expect(serialized).not.toContain(secret);
  }
}

describe("audit plugin: device enrolment (E2) and device login (L2)", () => {
  const session = {
    id: "session_device",
    userId: "auth_user_01",
    token: "tok_device",
    createdAt: new Date("2026-09-11T11:59:00.000Z"),
    authenticationLevel: "device_biometric",
  };
  const newSession = { session: { id: "session_device", userId: "auth_user_01" }, user: { id: "auth_user_01" } };
  const headers = new Headers({ "x-trace-id": "trace_device" });

  it("records only session_created when the device session row is written, not login_succeeded", async () => {
    const { plugin, events, onLoginMethodUsed } = build();
    const hooks = await databaseHooks(plugin);

    await hooks.session.create.after(session, { path: "/device/login/verify", headers, body: loginBody("device_01") });

    expect(events.map((event) => event.eventKey)).toEqual(["better_auth:session_created:session_device"]);
    expect(events[0]?.changes).toEqual({
      trace_id: "trace_device",
      authentication_method: "device_biometric",
      source: "/device/login/verify",
    });
    // A device key is not one of the account's linked login methods.
    expect(onLoginMethodUsed).not.toHaveBeenCalled();
  });

  it("records a completed device login as login_succeeded with device_id and purpose", async () => {
    const { plugin, events } = build();

    await runAfterHook(plugin, {
      path: "/device/login/verify",
      headers,
      body: loginBody("device_01"),
      context: { returned: { device_id: "device_01", authentication_level: "device_biometric" }, newSession },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventKey: "better_auth:login_succeeded:session_device",
      action: "authentication.login_succeeded",
      betterAuthUserId: "auth_user_01",
      resourceType: "account",
      resourceId: "auth_user_01",
      changes: {
        trace_id: "trace_device",
        authentication_method: "device_biometric",
        provider_session_id: "session_device",
        device_id: "device_01",
        purpose: "login",
      },
    });
    expectNoCeremonyMaterial(events);
  });

  it("records a completed enrolment with its new device_id, and the pending session it replaces as rotated", async () => {
    const { plugin, events } = build();
    const hooks = await databaseHooks(plugin);

    await hooks.session.create.after(session, { path: "/device/enrol/verify", headers, body: enrolBody() });
    await hooks.session.delete.after(
      { id: "session_pending", userId: "auth_user_01" },
      { path: "/device/enrol/verify", headers, body: enrolBody() },
    );
    await runAfterHook(plugin, {
      path: "/device/enrol/verify",
      headers,
      body: enrolBody(),
      context: { returned: { device_id: "device_new", status: "active" }, newSession },
    });

    expect(events.map((event) => event.eventKey)).toEqual([
      "better_auth:session_created:session_device",
      "better_auth:session_revoked:session_pending",
      "better_auth:login_succeeded:session_device",
    ]);
    expect(events[1]?.changes).toEqual({ trace_id: "trace_device", reason: "rotated" });
    expect(events[2]?.changes).toEqual({
      trace_id: "trace_device",
      authentication_method: "device_biometric",
      provider_session_id: "session_device",
      device_id: "device_new",
      purpose: "enrol-device",
    });
    expectNoCeremonyMaterial(events);
  });

  it("never records success when the ceremony fails after its session row was written", async () => {
    const { plugin, events } = build();
    const hooks = await databaseHooks(plugin);

    await hooks.session.create.after(session, { path: "/device/enrol/verify", headers, body: enrolBody() });
    await runAfterHook(plugin, {
      path: "/device/enrol/verify",
      headers,
      body: enrolBody(),
      context: {
        returned: APIError.from("INTERNAL_SERVER_ERROR", { code: "device.session_creation_failed", message: "x" }),
        session: { user: { id: "auth_user_01" }, session: { id: "session_pending" } },
        newSession,
      },
    });

    expect(events.map((event) => event.action)).toEqual([
      "authentication.session_created",
      "authentication.login_failed",
    ]);
  });

  it("links a failed device login with a real device_id to that device's account", async () => {
    const findDeviceOwner = vi.fn().mockResolvedValue("auth_user_01");
    const { plugin, events } = build(findDeviceOwner);

    await runAfterHook(plugin, {
      path: "/device/login/verify",
      headers,
      body: loginBody("device_01"),
      context: {
        returned: APIError.from("UNAUTHORIZED", { code: "DEVICE_LOGIN_FAILED", message: "Device login failed." }),
        session: null,
      },
    });

    expect(findDeviceOwner).toHaveBeenCalledWith("device_01");
    expect(events[0]).toMatchObject({
      action: "authentication.login_failed",
      betterAuthUserId: "auth_user_01",
      resourceType: "account",
      resourceId: "auth_user_01",
      changes: {
        trace_id: "trace_device",
        authentication_method: "device_biometric",
        failure_code: "DEVICE_LOGIN_FAILED",
        purpose: "login",
        device_id: "device_01",
      },
    });
    expectNoCeremonyMaterial(events);
  });

  it("records a failed device login with an unknown device_id against a keyed hash only", async () => {
    const { plugin, events } = build(vi.fn().mockResolvedValue(null));

    await runAfterHook(plugin, {
      path: "/device/login/verify",
      headers,
      body: loginBody("device_does_not_exist"),
      context: {
        returned: APIError.from("UNAUTHORIZED", { code: "DEVICE_LOGIN_FAILED", message: "Device login failed." }),
        session: null,
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      betterAuthUserId: null,
      attributeToSubject: false,
      resourceType: "login_attempt",
      resourceId: `login_device_${createHmac("sha256", HASH_KEY).update("device_does_not_exist").digest("hex")}`,
      changes: { failure_code: "DEVICE_LOGIN_FAILED", purpose: "login" },
    });
    expect(events[0]?.changes).not.toHaveProperty("device_id");
    expectNoCeremonyMaterial(events, ["device_does_not_exist"]);
  });

  it("still records a failed device login, against the keyed hash, when the device-owner lookup throws", async () => {
    const events: AuthAuditEvent[] = [];
    const lookupError = new Error("device lookup failed");
    const onError = vi.fn();
    const plugin = createBetterAuthAuditPlugin({
      sink: { record: vi.fn(async (event: AuthAuditEvent) => void events.push(event)) },
      identifierHashKey: HASH_KEY,
      clock: () => new Date("2026-09-11T12:00:00.000Z"),
      onError,
      findDeviceOwner: vi.fn().mockRejectedValue(lookupError),
    });

    await runAfterHook(plugin, {
      path: "/device/login/verify",
      headers,
      body: loginBody("device_01"),
      context: {
        returned: APIError.from("UNAUTHORIZED", { code: "DEVICE_LOGIN_FAILED", message: "Device login failed." }),
        session: null,
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "authentication.login_failed",
      betterAuthUserId: null,
      resourceType: "login_attempt",
      resourceId: `login_device_${createHmac("sha256", HASH_KEY).update("device_01").digest("hex")}`,
      changes: { failure_code: "DEVICE_LOGIN_FAILED", purpose: "login" },
    });
    expect(events[0]?.changes).not.toHaveProperty("device_id");
    expect(onError).toHaveBeenCalledWith(lookupError);
  });

  it("records a failed enrolment against the pending session's user, without attestation material", async () => {
    const { plugin, events } = build();

    await runAfterHook(plugin, {
      path: "/device/enrol/verify",
      headers,
      body: enrolBody(),
      context: {
        returned: APIError.from("BAD_REQUEST", {
          code: "ATTESTATION_INVALID",
          message: "This device can't be used for VistaBlox.",
        }),
        session: { user: { id: "auth_user_01" }, session: { id: "session_pending" } },
      },
    });

    expect(events[0]).toMatchObject({
      betterAuthUserId: "auth_user_01",
      resourceType: "account",
      resourceId: "auth_user_01",
      changes: {
        trace_id: "trace_device",
        authentication_method: "device_biometric",
        failure_code: "ATTESTATION_INVALID",
        purpose: "enrol-device",
      },
    });
    expectNoCeremonyMaterial(events);
  });

  it("records a failed enrolment with no pending session as an unattributed attempt", async () => {
    const { plugin, events } = build();

    await runAfterHook(plugin, {
      path: "/device/enrol/verify",
      headers,
      body: enrolBody(),
      context: {
        returned: APIError.from("BAD_REQUEST", { code: "DEVICE_JWS_INVALID", message: "x" }),
        session: null,
      },
    });

    expect(events[0]).toMatchObject({
      betterAuthUserId: null,
      resourceType: "login_attempt",
      resourceId: "login_unknown",
      changes: { failure_code: "DEVICE_JWS_INVALID" },
    });
  });
});

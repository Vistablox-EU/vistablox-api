import { createHmac } from "node:crypto";

import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";

import type { AuthAuditEvent, AuthAuditSink } from "../src/modules/auth/application/auth-audit-sink.js";
import { createBetterAuthAuditPlugin } from "../src/modules/auth/infrastructure/better-auth-audit.plugin.js";
import { recordVerifiedLoginDpopJkt } from "../src/modules/auth/infrastructure/device-login-audit-context.js";

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

type FindDeviceByDpopJkt = (dpopJkt: string) => Promise<{ betterAuthUserId: string; deviceId: string } | null>;

function build(findDeviceByDpopJkt?: FindDeviceByDpopJkt) {
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
    ...(findDeviceByDpopJkt === undefined ? {} : { findDeviceByDpopJkt }),
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

  // L2 failures are attributed from the request's verified DPoP key
  // (recorded by the device-auth plugin), never from the body's device_id.
  function failedLoginContext(verifiedJkt: string | null): Record<string, unknown> {
    const inner: Record<string, unknown> = {
      returned: APIError.from("UNAUTHORIZED", { code: "DEVICE_LOGIN_FAILED", message: "Device login failed." }),
      session: null,
    };
    if (verifiedJkt !== null) recordVerifiedLoginDpopJkt(inner, verifiedJkt);
    return inner;
  }

  it("attributes a failed device login to the device its verified DPoP key belongs to, not to a device_id named in the body", async () => {
    const findDeviceByDpopJkt = vi.fn().mockResolvedValue({ betterAuthUserId: "auth_user_key_owner", deviceId: "device_of_key" });
    const { plugin, events } = build(findDeviceByDpopJkt);

    await runAfterHook(plugin, {
      path: "/device/login/verify",
      headers,
      body: loginBody("device_of_victim"),
      context: failedLoginContext("jkt_of_requester"),
    });

    expect(findDeviceByDpopJkt).toHaveBeenCalledWith("jkt_of_requester");
    expect(events[0]).toMatchObject({
      action: "authentication.login_failed",
      betterAuthUserId: "auth_user_key_owner",
      resourceType: "account",
      resourceId: "auth_user_key_owner",
      changes: {
        trace_id: "trace_device",
        authentication_method: "device_biometric",
        failure_code: "DEVICE_LOGIN_FAILED",
        purpose: "login",
        device_id: "device_of_key",
      },
    });
    expectNoCeremonyMaterial(events, ["device_of_victim"]);
  });

  it("attributes a failed device login that sent no device_id (contract 3.1) to the key's device", async () => {
    const { plugin, events } = build(vi.fn().mockResolvedValue({ betterAuthUserId: "auth_user_01", deviceId: "device_01" }));

    await runAfterHook(plugin, {
      path: "/device/login/verify",
      headers,
      body: { challenge: CHALLENGE, jws: JWS },
      context: failedLoginContext("jkt_01"),
    });

    expect(events[0]).toMatchObject({ betterAuthUserId: "auth_user_01", changes: { device_id: "device_01" } });
  });

  it("records a failed device login whose DPoP key has no device against a keyed hash of the key only", async () => {
    const { plugin, events } = build(vi.fn().mockResolvedValue(null));

    await runAfterHook(plugin, {
      path: "/device/login/verify",
      headers,
      body: loginBody("device_does_not_exist"),
      context: failedLoginContext("jkt_nobody"),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      betterAuthUserId: null,
      attributeToSubject: false,
      resourceType: "login_attempt",
      resourceId: `login_dpop_${createHmac("sha256", HASH_KEY).update("jkt_nobody").digest("hex")}`,
      changes: { failure_code: "DEVICE_LOGIN_FAILED", purpose: "login" },
    });
    expect(events[0]?.changes).not.toHaveProperty("device_id");
    expectNoCeremonyMaterial(events, ["device_does_not_exist"]);
  });

  it("records a failed device login with no verified DPoP key as login_unknown, without any lookup", async () => {
    const findDeviceByDpopJkt = vi.fn();
    const { plugin, events } = build(findDeviceByDpopJkt);

    await runAfterHook(plugin, {
      path: "/device/login/verify",
      headers,
      body: loginBody("device_of_victim"),
      context: failedLoginContext(null),
    });

    expect(findDeviceByDpopJkt).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ betterAuthUserId: null, resourceType: "login_attempt", resourceId: "login_unknown" });
    expectNoCeremonyMaterial(events, ["device_of_victim"]);
  });

  it("still records a failed device login, against the keyed hash of the key, when the device lookup throws", async () => {
    const events: AuthAuditEvent[] = [];
    const lookupError = new Error("device lookup failed");
    const onError = vi.fn();
    const plugin = createBetterAuthAuditPlugin({
      sink: { record: vi.fn(async (event: AuthAuditEvent) => void events.push(event)) },
      identifierHashKey: HASH_KEY,
      clock: () => new Date("2026-09-11T12:00:00.000Z"),
      onError,
      findDeviceByDpopJkt: vi.fn().mockRejectedValue(lookupError),
    });

    await runAfterHook(plugin, {
      path: "/device/login/verify",
      headers,
      body: loginBody("device_01"),
      context: failedLoginContext("jkt_01"),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "authentication.login_failed",
      betterAuthUserId: null,
      resourceType: "login_attempt",
      resourceId: `login_dpop_${createHmac("sha256", HASH_KEY).update("jkt_01").digest("hex")}`,
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

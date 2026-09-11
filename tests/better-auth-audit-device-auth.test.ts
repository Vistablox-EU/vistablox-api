import { createHmac } from "node:crypto";

import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";

import type { AuthAuditEvent, AuthAuditSink } from "../src/modules/auth/application/auth-audit-sink.js";
import { createBetterAuthAuditPlugin } from "../src/modules/auth/infrastructure/better-auth-audit.plugin.js";

// E2 (/device/enrol/verify) and L2 (/device/login/verify) are recorded the
// same way the existing login paths are: session_created + login_succeeded
// from the session hooks, login_failed from the after hook. No attestation
// chain, integrity token, JWS, challenge or key material may reach an audit
// payload.
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

function build() {
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
  const headers = new Headers({ "x-trace-id": "trace_device" });

  it("records a device login as login_succeeded with method device_biometric and the verified device_id", async () => {
    const { plugin, events, onLoginMethodUsed } = build();
    const hooks = await databaseHooks(plugin);

    await hooks.session.create.after(session, {
      path: "/device/login/verify",
      headers,
      body: { device_id: "device_01", challenge: CHALLENGE, jws: JWS },
    });

    expect(events.map((event) => event.eventKey)).toEqual([
      "better_auth:session_created:session_device",
      "better_auth:login_succeeded:session_device",
    ]);
    expect(events[0]?.changes).toEqual({
      trace_id: "trace_device",
      authentication_method: "device_biometric",
      source: "/device/login/verify",
    });
    expect(events[1]).toMatchObject({
      action: "authentication.login_succeeded",
      betterAuthUserId: "auth_user_01",
      resourceType: "account",
      resourceId: "auth_user_01",
      changes: {
        trace_id: "trace_device",
        authentication_method: "device_biometric",
        provider_session_id: "session_device",
        device_id: "device_01",
      },
    });
    // A device key is not one of the account's linked login methods.
    expect(onLoginMethodUsed).not.toHaveBeenCalled();
    expectNoCeremonyMaterial(events);
  });

  it("records a device enrolment as login_succeeded, and the pending session it replaces as revoked with reason rotated", async () => {
    const { plugin, events } = build();
    const hooks = await databaseHooks(plugin);

    await hooks.session.create.after(session, { path: "/device/enrol/verify", headers, body: enrolBody() });
    await hooks.session.delete.after(
      { id: "session_pending", userId: "auth_user_01" },
      { path: "/device/enrol/verify", headers, body: enrolBody() },
    );

    expect(events.map((event) => event.eventKey)).toEqual([
      "better_auth:session_created:session_device",
      "better_auth:login_succeeded:session_device",
      "better_auth:session_revoked:session_pending",
    ]);
    expect(events[1]?.changes).toEqual({
      trace_id: "trace_device",
      authentication_method: "device_biometric",
      provider_session_id: "session_device",
    });
    expect(events[2]?.changes).toEqual({ trace_id: "trace_device", reason: "rotated" });
    expectNoCeremonyMaterial(events);
  });

  it("records a failed device login against a hash of the device_id, never the raw request", async () => {
    const { plugin, events } = build();

    await runAfterHook(plugin, {
      path: "/device/login/verify",
      headers,
      body: { device_id: "device_does_not_exist", challenge: CHALLENGE, jws: JWS },
      context: {
        returned: APIError.from("UNAUTHORIZED", { code: "DEVICE_LOGIN_FAILED", message: "Device login failed." }),
        session: null,
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "authentication.login_failed",
      betterAuthUserId: null,
      attributeToSubject: false,
      resourceType: "login_attempt",
      resourceId: `login_device_${createHmac("sha256", HASH_KEY).update("device_does_not_exist").digest("hex")}`,
      changes: {
        trace_id: "trace_device",
        authentication_method: "device_biometric",
        failure_code: "DEVICE_LOGIN_FAILED",
      },
    });
    expect(events[0]?.eventKey.startsWith("better_auth:login_failed:")).toBe(true);
    expectNoCeremonyMaterial(events, ["device_does_not_exist"]);
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

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "authentication.login_failed",
      betterAuthUserId: "auth_user_01",
      resourceType: "account",
      resourceId: "auth_user_01",
      changes: {
        trace_id: "trace_device",
        authentication_method: "device_biometric",
        failure_code: "ATTESTATION_INVALID",
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

  it("records nothing from the after hook when the device ceremony succeeded", async () => {
    const { plugin, sink } = build();

    await runAfterHook(plugin, {
      path: "/device/login/verify",
      headers,
      body: { device_id: "device_01", challenge: CHALLENGE, jws: JWS },
      context: { returned: { device_id: "device_01" }, session: null },
    });

    expect(sink.record).not.toHaveBeenCalled();
  });
});

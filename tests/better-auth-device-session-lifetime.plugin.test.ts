import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBetterAuthDeviceSessionLifetimePlugin,
  createDeviceSessionLifetime,
  isDeviceSessionLookupWrapped,
} from "../src/modules/auth/infrastructure/better-auth-device-session-lifetime.plugin.js";

// A real better-auth instance (in-memory database, same session settings
// as better-auth.factory.ts: expiresIn 30 min, updateAge 5 min, bearer
// tokens) with only the device-session lifetime plugin added. This runs
// better-auth's real get-session code, including its silent-renewal branch,
// so the tests prove the plugin's hooks against the actual dispatch, not a
// hand-built context. Fake timers move only Date.
const T0 = new Date("2026-09-11T12:00:00.000Z");
const MINUTE = 60_000;

type Row = Record<string, unknown> & { token: string };

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

async function buildAuth() {
  const db: Record<string, Row[]> = { user: [], session: [], account: [], verification: [] };
  const auth = betterAuth({
    database: memoryAdapter(db),
    baseURL: "http://localhost:3000",
    secret: "unit-test-secret-that-is-at-least-32-characters-long",
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: 30 * 60,
      updateAge: 5 * 60,
      additionalFields: {
        authenticationLevel: { type: "string", required: false, input: false },
      },
    },
    plugins: [bearer(), createBetterAuthDeviceSessionLifetimePlugin()],
  });
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser(
    { name: "Lifetime Test", email: "lifetime@example.test", emailVerified: true },
    { method: "internal" },
  );

  async function createSession(authenticationLevel: string): Promise<string> {
    // What better-auth.factory.ts's session.create.before produces for a
    // device session: expiresAt = createdAt + 30 min, updatedAt = createdAt.
    const created = await context.internalAdapter.createSession(
      user.id,
      false,
      {
        authenticationLevel,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * MINUTE),
      },
      true,
    );
    return created.token;
  }

  function row(token: string): Row | undefined {
    return db.session!.find((candidate) => candidate.token === token);
  }

  function setRow(token: string, patch: Record<string, unknown>): void {
    Object.assign(row(token) as Row, patch);
  }

  function bearerHeaders(token: string): Headers {
    return new Headers({ authorization: `Bearer ${token}` });
  }

  function getSession(token: string) {
    return auth.api.getSession({ headers: bearerHeaders(token) });
  }

  // Two routes that read the session through getSessionFromCtx rather than
  // the get-session endpoint.
  function listSessions(token: string) {
    return auth.api.listSessions({ headers: bearerHeaders(token) });
  }

  function updateUser(token: string) {
    return auth.api.updateUser({ headers: bearerHeaders(token), body: { name: "Renamed" } });
  }

  return { context, createSession, row, setRow, getSession, listSessions, updateUser };
}

describe("device session lifetime plugin (real better-auth get-session)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a device session within both limits", async () => {
    const harness = await buildAuth();
    const token = await harness.createSession("device_biometric");

    vi.setSystemTime(at(4 * MINUTE));
    const result = await harness.getSession(token);

    expect(result?.session.token).toBe(token);
    expect(harness.row(token)?.expiresAt).toEqual(at(30 * MINUTE));
  });

  it("does not silently renew a device session: a due refresh leaves expiresAt and updatedAt as stored", async () => {
    const harness = await buildAuth();
    const token = await harness.createSession("device_biometric");
    // Last recorded activity at 8 min; at 10 min better-auth's refresh is
    // due (expiresAt - expiresIn + updateAge = 5 min <= now).
    harness.setRow(token, { updatedAt: at(8 * MINUTE) });

    vi.setSystemTime(at(10 * MINUTE));
    const result = await harness.getSession(token);

    expect(result?.session.expiresAt).toEqual(at(30 * MINUTE));
    expect(harness.row(token)?.expiresAt).toEqual(at(30 * MINUTE));
    // Resolving the session is not activity; only a fully authenticated
    // /v1 request records it (BetterAuthSessionResolver.recordActivity).
    expect(harness.row(token)?.updatedAt).toEqual(at(8 * MINUTE));
  });

  it("answers REAUTH_REQUIRED exactly at the idle limit and deletes the session", async () => {
    const harness = await buildAuth();
    const token = await harness.createSession("device_biometric");

    vi.setSystemTime(at(5 * MINUTE - 1));
    await expect(harness.getSession(token)).resolves.not.toBeNull();

    vi.setSystemTime(at(5 * MINUTE));
    await expect(harness.getSession(token)).rejects.toMatchObject({
      statusCode: 401,
      body: { code: "REAUTH_REQUIRED" },
    });
    expect(harness.row(token)).toBeUndefined();
  });

  it("answers REAUTH_REQUIRED exactly at the absolute limit even with activity a moment before", async () => {
    const harness = await buildAuth();
    const token = await harness.createSession("device_biometric");

    vi.setSystemTime(at(30 * MINUTE - 1));
    harness.setRow(token, { updatedAt: at(30 * MINUTE - 2) });
    await expect(harness.getSession(token)).resolves.not.toBeNull();

    vi.setSystemTime(at(30 * MINUTE));
    harness.setRow(token, { updatedAt: at(30 * MINUTE - 1) });
    await expect(harness.getSession(token)).rejects.toMatchObject({
      statusCode: 401,
      body: { code: "REAUTH_REQUIRED" },
    });
    expect(harness.row(token)).toBeUndefined();
  });

  it("answers REAUTH_REQUIRED, not an anonymous null, once better-auth has expired the device session itself", async () => {
    const harness = await buildAuth();
    const token = await harness.createSession("device_biometric");

    vi.setSystemTime(at(31 * MINUTE));
    harness.setRow(token, { updatedAt: at(31 * MINUTE - 10_000) });
    await expect(harness.getSession(token)).rejects.toMatchObject({
      statusCode: 401,
      body: { code: "REAUTH_REQUIRED" },
    });
    expect(harness.row(token)).toBeUndefined();
  });

  it("enforces the absolute limit from createdAt even if expiresAt was somehow extended", async () => {
    const harness = await buildAuth();
    const token = await harness.createSession("device_biometric");
    harness.setRow(token, { expiresAt: at(120 * MINUTE) });

    vi.setSystemTime(at(30 * MINUTE));
    harness.setRow(token, { updatedAt: at(30 * MINUTE - 1_000) });
    await expect(harness.getSession(token)).rejects.toMatchObject({
      body: { code: "REAUTH_REQUIRED" },
    });
  });

  it("leaves non-device sessions exactly as before: no idle limit, rolling renewal", async () => {
    const harness = await buildAuth();
    const token = await harness.createSession("staff_passkey");

    vi.setSystemTime(at(10 * MINUTE));
    const result = await harness.getSession(token);

    expect(result?.session.token).toBe(token);
    expect(harness.row(token)?.expiresAt).toEqual(at(40 * MINUTE));
  });

  it("still returns null for an unknown token", async () => {
    const harness = await buildAuth();

    await expect(harness.getSession("unknown-session-token")).resolves.toBeNull();
  });
});

describe("device session lifetime plugin: every session lookup, not just get-session", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a device session idle for 12 minutes on list-sessions, and ends it", async () => {
    const harness = await buildAuth();
    const token = await harness.createSession("device_biometric");

    vi.setSystemTime(at(12 * MINUTE));
    await expect(harness.listSessions(token)).rejects.toMatchObject({ statusCode: 401 });
    expect(harness.row(token)).toBeUndefined();
  });

  it("refuses a device session idle for 12 minutes on update-user, and ends it", async () => {
    const harness = await buildAuth();
    const token = await harness.createSession("device_biometric");

    vi.setSystemTime(at(12 * MINUTE));
    await expect(harness.updateUser(token)).rejects.toMatchObject({ statusCode: 401 });
    expect(harness.row(token)).toBeUndefined();
  });

  it("refuses a device session past its absolute limit on both routes, even with recent activity", async () => {
    const harness = await buildAuth();
    const first = await harness.createSession("device_biometric");
    const second = await harness.createSession("device_biometric");

    vi.setSystemTime(at(30 * MINUTE));
    harness.setRow(first, { updatedAt: at(30 * MINUTE - 1_000) });
    harness.setRow(second, { updatedAt: at(30 * MINUTE - 1_000) });
    await expect(harness.listSessions(first)).rejects.toMatchObject({ statusCode: 401 });
    await expect(harness.updateUser(second)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("accepts a device session within both limits on both routes", async () => {
    const harness = await buildAuth();
    const token = await harness.createSession("device_biometric");

    vi.setSystemTime(at(4 * MINUTE));
    await expect(harness.listSessions(token)).resolves.toBeDefined();
    await expect(harness.updateUser(token)).resolves.toBeDefined();
    expect(harness.row(token)).toBeDefined();
  });

  it("leaves non-device sessions usable on both routes after 12 idle minutes", async () => {
    const harness = await buildAuth();
    const token = await harness.createSession("staff_passkey");

    vi.setSystemTime(at(12 * MINUTE));
    await expect(harness.listSessions(token)).resolves.toBeDefined();
    await expect(harness.updateUser(token)).resolves.toBeDefined();
  });
});

describe("device session lifetime plugin: no refresh write for device sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The race: get-session reads the row, a concurrent authenticated request
  // records newer activity, then get-session's refresh writes the row back
  // with the value it read, undoing that activity. With no refresh write for
  // device sessions there is nothing to overwrite. A non-device session in
  // the same situation still refreshes, showing the write path exists.
  it("never writes to a device session on a refresh-due lookup, while a non-device session still refreshes", async () => {
    const harness = await buildAuth();
    const deviceToken = await harness.createSession("device_biometric");
    const webToken = await harness.createSession("staff_passkey");
    harness.setRow(deviceToken, { updatedAt: at(8 * MINUTE) });
    const updateSession = vi.spyOn(harness.context.internalAdapter, "updateSession");

    vi.setSystemTime(at(10 * MINUTE));
    await harness.getSession(deviceToken);
    await harness.listSessions(deviceToken);
    expect(updateSession).not.toHaveBeenCalled();

    // Newer activity recorded meanwhile survives the lookups untouched.
    harness.setRow(deviceToken, { updatedAt: at(10 * MINUTE) });
    await harness.getSession(deviceToken);
    expect(harness.row(deviceToken)?.updatedAt).toEqual(at(10 * MINUTE));
    expect(updateSession).not.toHaveBeenCalled();

    await harness.getSession(webToken);
    expect(updateSession).toHaveBeenCalledTimes(1);
  });
});

describe("device session lifetime: attached before any request", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces the limits on a direct findSession call once attached, with no request having run", async () => {
    const db: Record<string, Row[]> = { user: [], session: [], account: [], verification: [] };
    const lifetime = createDeviceSessionLifetime();
    const auth = betterAuth({
      database: memoryAdapter(db),
      baseURL: "http://localhost:3000",
      secret: "unit-test-secret-that-is-at-least-32-characters-long",
      emailAndPassword: { enabled: false },
      session: {
        expiresIn: 30 * 60,
        updateAge: 5 * 60,
        additionalFields: { authenticationLevel: { type: "string", required: false, input: false } },
      },
      plugins: [bearer(), lifetime.plugin],
    });
    const context = await auth.$context;
    expect(isDeviceSessionLookupWrapped(context.internalAdapter)).toBe(false);

    lifetime.attach(context.internalAdapter);
    lifetime.attach(context.internalAdapter);

    expect(isDeviceSessionLookupWrapped(context.internalAdapter)).toBe(true);
    const user = await context.internalAdapter.createUser(
      { name: "Attach Test", email: "attach@example.test", emailVerified: true },
      { method: "internal" },
    );
    const created = await context.internalAdapter.createSession(
      user.id,
      false,
      { authenticationLevel: "device_biometric", expiresAt: at(30 * MINUTE) },
      true,
    );
    vi.setSystemTime(at(12 * MINUTE));
    const found = (await context.internalAdapter.findSession(created.token)) as {
      session: { expiresAt: Date };
    } | null;
    expect(found?.session.expiresAt.getTime()).toBeLessThan(at(12 * MINUTE).getTime());
  });
});

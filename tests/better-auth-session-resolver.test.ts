import { APIError } from "better-auth/api";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedIdentity } from "../src/modules/auth/application/session-resolver.js";
import type { SessionMirror } from "../src/modules/auth/application/session-mirror.js";
import { BetterAuthSessionResolver } from "../src/modules/auth/infrastructure/better-auth-session.resolver.js";
import type { VistaBloxAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { AppError } from "../src/shared/errors/app-error.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const MINUTE = 60_000;

function buildResolver(options: {
  getSession?: ReturnType<typeof vi.fn>;
  rowCount?: number;
  sessionMirror?: SessionMirror;
  onMirrorError?: (error: unknown) => void;
}) {
  const auth = { api: { getSession: options.getSession ?? vi.fn() } } as unknown as VistaBloxAuth;
  const query = vi.fn().mockResolvedValue({ rowCount: options.rowCount ?? 1 });
  const pool = { query } as unknown as Pool;
  const resolver = new BetterAuthSessionResolver(auth, pool, {
    clock: () => NOW,
    ...(options.sessionMirror === undefined ? {} : { sessionMirror: options.sessionMirror }),
    ...(options.onMirrorError === undefined ? {} : { onMirrorError: options.onMirrorError }),
  });
  return { resolver, query };
}

function identity(createdAt: Date): AuthenticatedIdentity {
  return {
    betterAuthUserId: "auth_user_01",
    providerSessionId: "session_01",
    population: "customer",
    dpopJkt: "jkt_01",
    sessionCreatedAt: createdAt,
    authenticationLevel: "device_biometric",
  };
}

describe("BetterAuthSessionResolver: device session time limits", () => {
  it("turns the lifetime plugin's REAUTH_REQUIRED into a 401 REAUTH_REQUIRED AppError", async () => {
    const { resolver } = buildResolver({
      getSession: vi.fn().mockRejectedValue(
        APIError.from("UNAUTHORIZED", { code: "REAUTH_REQUIRED", message: "time limit" }),
      ),
    });

    const failure = await resolver.resolve({}).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: "REAUTH_REQUIRED", status: 401 });
  });

  it("rethrows any other better-auth error unchanged", async () => {
    const other = APIError.from("UNAUTHORIZED", { code: "FAILED_TO_GET_SESSION", message: "x" });
    const { resolver } = buildResolver({ getSession: vi.fn().mockRejectedValue(other) });

    await expect(resolver.resolve({})).rejects.toBe(other);
  });

  it("records activity on device sessions only, and moves the mirror's idle expiry forward", async () => {
    const sessionMirror: SessionMirror = {
      recordCreated: vi.fn(),
      recordRevoked: vi.fn(),
      recordActivity: vi.fn().mockResolvedValue(undefined),
    };
    const { resolver, query } = buildResolver({ sessionMirror });

    await resolver.recordActivity(identity(new Date(NOW.getTime() - 10 * MINUTE)));

    // GREATEST: never moves activity backwards. The last two conditions
    // re-check both limits, so nothing is written to an expired session.
    expect(query).toHaveBeenCalledWith(
      'UPDATE "auth_session" SET "updatedAt" = GREATEST("updatedAt", $1) WHERE "id" = $2 AND "authenticationLevel" = $3 AND "createdAt" > $4 AND "updatedAt" > $5',
      [
        NOW,
        "session_01",
        "device_biometric",
        new Date(NOW.getTime() - 30 * MINUTE),
        new Date(NOW.getTime() - 5 * MINUTE),
      ],
    );
    expect(sessionMirror.recordActivity).toHaveBeenCalledWith({
      betterAuthSessionId: "session_01",
      seenAt: NOW,
      idleExpiresAt: new Date(NOW.getTime() + 5 * MINUTE),
    });
  });

  it("updates only mirror activity for a session that isn't a device session", async () => {
    const sessionMirror: SessionMirror = {
      recordCreated: vi.fn(),
      recordRevoked: vi.fn(),
      recordActivity: vi.fn(),
    };
    const { resolver, query } = buildResolver({ sessionMirror });

    await resolver.recordActivity({ ...identity(new Date(NOW.getTime() - MINUTE)), authenticationLevel: "oauth_passkey" });

    expect(query).not.toHaveBeenCalled();
    expect(sessionMirror.recordActivity).toHaveBeenCalledWith({
      betterAuthSessionId: "session_01",
      seenAt: NOW,
    });
  });

  it("never gives the mirror an idle expiry past the absolute limit", async () => {
    const sessionMirror: SessionMirror = {
      recordCreated: vi.fn(),
      recordRevoked: vi.fn(),
      recordActivity: vi.fn().mockResolvedValue(undefined),
    };
    const { resolver } = buildResolver({ sessionMirror });
    const createdAt = new Date(NOW.getTime() - 28 * MINUTE);

    await resolver.recordActivity(identity(createdAt));

    expect(sessionMirror.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ idleExpiresAt: new Date(createdAt.getTime() + 30 * MINUTE) }),
    );
  });

  it("leaves the mirror alone when the session isn't a device session (no row updated)", async () => {
    const sessionMirror: SessionMirror = {
      recordCreated: vi.fn(),
      recordRevoked: vi.fn(),
      recordActivity: vi.fn(),
    };
    const { resolver } = buildResolver({ sessionMirror, rowCount: 0 });

    await resolver.recordActivity(identity(new Date(NOW.getTime() - MINUTE)));

    expect(sessionMirror.recordActivity).not.toHaveBeenCalled();
  });

  it("reports a failed mirror write instead of failing the request", async () => {
    const mirrorFailure = new Error("mirror down");
    const onMirrorError = vi.fn();
    const sessionMirror: SessionMirror = {
      recordCreated: vi.fn(),
      recordRevoked: vi.fn(),
      recordActivity: vi.fn().mockRejectedValue(mirrorFailure),
    };
    const { resolver } = buildResolver({ sessionMirror, onMirrorError });

    await expect(resolver.recordActivity(identity(new Date(NOW.getTime() - MINUTE)))).resolves.toBeUndefined();
    expect(onMirrorError).toHaveBeenCalledWith(mirrorFailure);
  });
});

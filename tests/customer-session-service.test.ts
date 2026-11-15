import { describe, expect, it, vi } from "vitest";

import {
  ListOwnSessionsService,
  RevokeAllOwnSessionsService,
  RevokeDeviceSessionsService,
  RevokeOwnSessionService,
} from "../src/modules/auth/application/customer/customer-session.service.js";
import type { SessionRevoker } from "../src/modules/auth/application/customer/session-revoker.js";
import type { ProviderSessionFacts } from "../src/modules/auth/domain/session-liveness.js";
import type {
  CustomerSessionRepository,
  CustomerSessionSummary,
} from "../src/modules/auth/repository/customer/customer-session.repository.js";

const NOW = new Date("2026-09-01T09:02:00.000Z");
const MINUTE = 60_000;

// What better-auth's own row says about a device session created at 09:00
// and last used at 09:00: live at NOW (2 min idle, 2 min old).
function liveProviderSession(): ProviderSessionFacts {
  return {
    authenticationLevel: "device_biometric",
    createdAt: new Date("2026-09-01T09:00:00.000Z"),
    updatedAt: new Date("2026-09-01T09:00:00.000Z"),
    expiresAt: new Date("2026-09-01T09:30:00.000Z"),
  };
}

// The same device session, long past its limits.
function expiredProviderSession(): ProviderSessionFacts {
  return {
    authenticationLevel: "device_biometric",
    createdAt: new Date("2026-08-31T09:00:00.000Z"),
    updatedAt: new Date("2026-08-31T09:00:00.000Z"),
    expiresAt: new Date("2026-08-31T09:30:00.000Z"),
  };
}

function summary(overrides: Partial<CustomerSessionSummary> = {}): CustomerSessionSummary {
  return {
    sessionId: "sess_01",
    channel: "web",
    deviceLabel: "Chrome on macOS",
    authMethodAtLogin: "device_biometric",
    createdAt: new Date("2026-08-31T09:00:00.000Z"),
    lastSeenAt: new Date("2026-09-01T09:00:00.000Z"),
    status: "active",
    revocationReason: null,
    betterAuthSessionId: "auth_session_01",
    providerSession: liveProviderSession(),
    ...overrides,
  };
}

function fakeRevoker(overrides: Partial<SessionRevoker> = {}): SessionRevoker {
  return { revoke: vi.fn(), revokeAll: vi.fn(), revokeByDpopKey: vi.fn(), ...overrides };
}

describe("ListOwnSessionsService", () => {
  it("marks the session matching the caller's own provider session as current", async () => {
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn().mockResolvedValue([
        summary({ sessionId: "sess_01", betterAuthSessionId: "auth_session_01" }),
        summary({ sessionId: "sess_02", betterAuthSessionId: "auth_session_02" }),
      ]),
      findOwnedProviderSessionId: vi.fn(),
    };
    const service = new ListOwnSessionsService(repository, () => NOW);

    const result = await service.execute("acct_01", "auth_session_02");

    expect(result.find((s) => s.sessionId === "sess_01")?.isCurrent).toBe(false);
    expect(result.find((s) => s.sessionId === "sess_02")?.isCurrent).toBe(true);
  });

  function listing(rows: CustomerSessionSummary[]): CustomerSessionRepository {
    return { listForAccount: vi.fn().mockResolvedValue(rows), findOwnedProviderSessionId: vi.fn() };
  }

  it("omits an active-looking session that can no longer authenticate", async () => {
    const service = new ListOwnSessionsService(
      listing([
        summary({ sessionId: "sess_live", betterAuthSessionId: "auth_live" }),
        summary({
          sessionId: "sess_expired",
          betterAuthSessionId: "auth_expired",
          providerSession: expiredProviderSession(),
        }),
        summary({ sessionId: "sess_gone", betterAuthSessionId: "auth_gone", providerSession: null }),
      ]),
      () => NOW,
    );

    const result = await service.execute("acct_01", "auth_other");

    expect(result.map((s) => s.sessionId)).toEqual(["sess_live"]);
  });

  it("omits a device session past its idle limit while better-auth's own expiresAt is still ahead", async () => {
    const idleExpired: ProviderSessionFacts = {
      ...liveProviderSession(),
      updatedAt: new Date(NOW.getTime() - 6 * MINUTE),
      createdAt: new Date(NOW.getTime() - 10 * MINUTE),
      expiresAt: new Date(NOW.getTime() + 20 * MINUTE),
    };
    const service = new ListOwnSessionsService(
      listing([summary({ sessionId: "sess_idle", providerSession: idleExpired })]),
      () => NOW,
    );

    expect(await service.execute("acct_01", "auth_other")).toEqual([]);
  });

  it("still returns revoked sessions, with their stored status and reason", async () => {
    const service = new ListOwnSessionsService(
      listing([
        summary({
          sessionId: "sess_revoked",
          status: "revoked",
          revocationReason: "self_revoke_one",
          providerSession: null,
        }),
      ]),
      () => NOW,
    );

    const result = await service.execute("acct_01", "auth_other");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: "revoked", revocationReason: "self_revoke_one" });
  });

  it("never drops the caller's own session, even if its stored facts look expired", async () => {
    // The caller has just authenticated with it, so a stale or lagging row
    // must not make it vanish from its own list.
    const service = new ListOwnSessionsService(
      listing([
        summary({
          sessionId: "sess_current",
          betterAuthSessionId: "auth_current",
          providerSession: expiredProviderSession(),
        }),
      ]),
      () => NOW,
    );

    const result = await service.execute("acct_01", "auth_current");

    expect(result.map((s) => [s.sessionId, s.isCurrent])).toEqual([["sess_current", true]]);
  });
});

describe("RevokeOwnSessionService", () => {
  it("revokes the Better Auth session owned by the caller", async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn(),
      findOwnedProviderSessionId: vi.fn().mockResolvedValue("auth_session_01"),
    };
    const revoker: SessionRevoker = fakeRevoker({ revoke });
    const service = new RevokeOwnSessionService(repository, revoker);
    const headers = { cookie: "vb_session=abc" };

    await service.execute("acct_01", "sess_01", headers);

    expect(repository.findOwnedProviderSessionId).toHaveBeenCalledWith("acct_01", "sess_01");
    expect(revoke).toHaveBeenCalledWith("auth_session_01", headers);
  });

  it("rejects a session ID that does not belong to the caller's account", async () => {
    const revoke = vi.fn();
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn(),
      findOwnedProviderSessionId: vi.fn().mockResolvedValue(null),
    };
    const service = new RevokeOwnSessionService(repository, fakeRevoker({ revoke }));

    await expect(service.execute("acct_01", "sess_not_owned", {})).rejects.toMatchObject({
      code: "resource.not_found",
      status: 404,
    });
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("RevokeAllOwnSessionsService", () => {
  it("revokes all web sessions for the account", async () => {
    const revokeAll = vi.fn().mockResolvedValue(undefined);
    const service = new RevokeAllOwnSessionsService(fakeRevoker({ revokeAll }));
    const headers = { cookie: "vb_session=abc" };

    await service.execute(headers);

    expect(revokeAll).toHaveBeenCalledWith(headers);
  });
});

describe("RevokeDeviceSessionsService", () => {
  it("revokes every session bound to the given key and reports how many", async () => {
    const revokeByDpopKey = vi.fn().mockResolvedValue(2);
    const service = new RevokeDeviceSessionsService(fakeRevoker({ revokeByDpopKey }));
    const headers = { authorization: "Bearer tok" };

    const result = await service.execute("jkt_abc123", headers);

    expect(revokeByDpopKey).toHaveBeenCalledWith("jkt_abc123", headers);
    expect(result).toEqual({ revokedCount: 2 });
  });
});

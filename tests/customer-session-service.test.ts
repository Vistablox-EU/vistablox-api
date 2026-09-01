import { describe, expect, it, vi } from "vitest";

import {
  ListOwnSessionsService,
  RevokeOwnSessionService,
} from "../src/modules/auth/application/customer-session.service.js";
import type { SessionRevoker } from "../src/modules/auth/application/session-revoker.js";
import type {
  CustomerSessionRepository,
  CustomerSessionSummary,
} from "../src/modules/auth/repository/customer-session.repository.js";
import type { OidcGrantRepository } from "../src/modules/auth/repository/oidc-grant.repository.js";

function summary(overrides: Partial<CustomerSessionSummary> = {}): CustomerSessionSummary {
  return {
    sessionId: "sess_01",
    channel: "web",
    deviceLabel: "Chrome on macOS",
    authMethodAtLogin: "email_password",
    createdAt: new Date("2026-08-31T09:00:00.000Z"),
    lastSeenAt: new Date("2026-09-01T09:00:00.000Z"),
    status: "active",
    revocationReason: null,
    betterAuthSessionId: "auth_session_01",
    ...overrides,
  };
}

describe("ListOwnSessionsService", () => {
  it("marks the session matching the caller's own provider session as current", async () => {
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn().mockResolvedValue([
        summary({ sessionId: "sess_01", betterAuthSessionId: "auth_session_01" }),
        summary({ sessionId: "sess_02", betterAuthSessionId: "auth_session_02" }),
      ]),
      findOwnedSessionToken: vi.fn(),
    };
    const service = new ListOwnSessionsService(repository);

    const result = await service.execute("acct_01", "auth_session_02");

    expect(result.find((s) => s.sessionId === "sess_01")?.isCurrent).toBe(false);
    expect(result.find((s) => s.sessionId === "sess_02")?.isCurrent).toBe(true);
  });
});

describe("RevokeOwnSessionService", () => {
  it("revokes the Better Auth token for a session owned by the caller", async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn(),
      findOwnedSessionToken: vi.fn().mockResolvedValue("tok_abc123"),
    };
    const revoker: SessionRevoker = { revoke };
    const service = new RevokeOwnSessionService(repository, revoker);
    const headers = { cookie: "vb_session=abc" };

    await service.execute("acct_01", "sess_01", headers);

    expect(repository.findOwnedSessionToken).toHaveBeenCalledWith("acct_01", "sess_01");
    expect(revoke).toHaveBeenCalledWith("tok_abc123", headers);
  });

  it("rejects a session ID that does not belong to the caller's account", async () => {
    const revoke = vi.fn();
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn(),
      findOwnedSessionToken: vi.fn().mockResolvedValue(null),
    };
    const service = new RevokeOwnSessionService(repository, { revoke });

    await expect(service.execute("acct_01", "sess_not_owned", {})).rejects.toMatchObject({
      code: "resource.not_found",
      status: 404,
    });
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("ListOwnSessionsService with native OIDC grants", () => {
  it("merges native grants into the same list, using the grant id to mark the current one", async () => {
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn().mockResolvedValue([summary({ sessionId: "sess_01" })]),
      findOwnedSessionToken: vi.fn(),
    };
    const grants: OidcGrantRepository = {
      listForAccount: vi.fn().mockResolvedValue([
        { grantId: "grant_01", createdAt: new Date("2026-08-30T09:00:00.000Z"), status: "active" },
      ]),
      isOwnedByAccount: vi.fn(),
      revoke: vi.fn(),
    };
    const service = new ListOwnSessionsService(repository, grants);

    const result = await service.execute("acct_01", "grant_01");

    expect(result).toHaveLength(2);
    expect(result.find((row) => row.sessionId === "sess_01")?.isCurrent).toBe(false);
    const grantRow = result.find((row) => row.sessionId === "grant_01");
    expect(grantRow).toMatchObject({
      channel: "native",
      deviceLabel: "VistaBlox Mobile/Desktop",
      authMethodAtLogin: "oidc_pkce",
      status: "active",
      revocationReason: null,
      betterAuthSessionId: null,
      isCurrent: true,
    });
  });

  it("returns only web sessions when no grants repository is configured", async () => {
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn().mockResolvedValue([summary({ sessionId: "sess_01" })]),
      findOwnedSessionToken: vi.fn(),
    };
    const service = new ListOwnSessionsService(repository);

    const result = await service.execute("acct_01", "auth_session_01");

    expect(result).toHaveLength(1);
    expect(result[0]?.sessionId).toBe("sess_01");
  });
});

describe("RevokeOwnSessionService with native OIDC grants", () => {
  it("revokes an owned grant when no web session matches the ID", async () => {
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn(),
      findOwnedSessionToken: vi.fn().mockResolvedValue(null),
    };
    const revoke = vi.fn();
    const grantRevoke = vi.fn().mockResolvedValue(undefined);
    const grants: OidcGrantRepository = {
      listForAccount: vi.fn(),
      isOwnedByAccount: vi.fn().mockResolvedValue(true),
      revoke: grantRevoke,
    };
    const service = new RevokeOwnSessionService(repository, { revoke }, grants);

    await service.execute("acct_01", "grant_01", {});

    expect(grants.isOwnedByAccount).toHaveBeenCalledWith("acct_01", "grant_01");
    expect(grantRevoke).toHaveBeenCalledWith("grant_01");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("rejects an ID that is neither an owned session nor an owned grant", async () => {
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn(),
      findOwnedSessionToken: vi.fn().mockResolvedValue(null),
    };
    const grants: OidcGrantRepository = {
      listForAccount: vi.fn(),
      isOwnedByAccount: vi.fn().mockResolvedValue(false),
      revoke: vi.fn(),
    };
    const service = new RevokeOwnSessionService(repository, { revoke: vi.fn() }, grants);

    await expect(service.execute("acct_01", "unknown_id", {})).rejects.toMatchObject({
      code: "resource.not_found",
      status: 404,
    });
  });
});

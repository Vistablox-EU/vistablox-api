import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createCustomerSessionRouter } from "../src/modules/auth/api/customer-session.router.js";
import {
  ListOwnSessionsService,
  RevokeAllOwnSessionsService,
  RevokeDeviceSessionsService,
  RevokeOwnSessionService,
} from "../src/modules/auth/application/customer-session.service.js";
import type { SessionRevoker } from "../src/modules/auth/application/session-revoker.js";
import type { CustomerSessionRepository } from "../src/modules/auth/repository/customer-session.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

function fakeRevoker(overrides: Partial<SessionRevoker> = {}): SessionRevoker {
  return { revoke: vi.fn(), revokeAll: vi.fn(), revokeByDpopKey: vi.fn(), ...overrides };
}

function buildApp(repository: CustomerSessionRepository, revoker: SessionRevoker) {
  const app = express();
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = {
      accountId: "acct_01",
      providerSessionId: "auth_session_current",
      population: "customer",
    };
    next();
  };
  app.use(requestContext);
  app.use(
    "/v1/auth/sessions",
    createCustomerSessionRouter(
      authenticated,
      new ListOwnSessionsService(repository),
      new RevokeOwnSessionService(repository, revoker),
      new RevokeAllOwnSessionsService(revoker),
      new RevokeDeviceSessionsService(revoker),
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("customer session API", () => {
  it("lists the caller's sessions with is_current set on their own session", async () => {
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn().mockResolvedValue([
        {
          sessionId: "sess_01",
          channel: "web",
          deviceLabel: "Chrome on macOS",
          authMethodAtLogin: "device_biometric",
          createdAt: new Date("2026-08-31T09:00:00.000Z"),
          lastSeenAt: new Date("2026-09-01T09:00:00.000Z"),
          status: "active",
          revocationReason: null,
          betterAuthSessionId: "auth_session_current",
        },
      ]),
      findOwnedSessionToken: vi.fn(),
    };

    const response = await request(buildApp(repository, fakeRevoker())).get(
      "/v1/auth/sessions",
    );

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data).toEqual([
      {
        session_id: "sess_01",
        channel: "web",
        device_label: "Chrome on macOS",
        auth_method_at_login: "device_biometric",
        created_at: "2026-08-31T09:00:00.000Z",
        last_seen_at: "2026-09-01T09:00:00.000Z",
        status: "active",
        revocation_reason: null,
        is_current: true,
      },
    ]);
  });

  it("revokes an owned session and returns 204", async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn(),
      findOwnedSessionToken: vi.fn().mockResolvedValue("tok_abc123"),
    };

    const response = await request(buildApp(repository, fakeRevoker({ revoke }))).post(
      "/v1/auth/sessions/sess_01/revoke",
    );

    expect(response.status).toBe(204);
    expect(revoke).toHaveBeenCalledWith("tok_abc123", expect.any(Object));
  });

  it("returns 404 for a session the caller does not own", async () => {
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn(),
      findOwnedSessionToken: vi.fn().mockResolvedValue(null),
    };

    const response = await request(buildApp(repository, fakeRevoker())).post(
      "/v1/auth/sessions/sess_not_owned/revoke",
    );

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "resource.not_found", status: 404 });
  });

  it("revokes every session for the caller and returns 204", async () => {
    const revokeAll = vi.fn().mockResolvedValue(undefined);
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn(),
      findOwnedSessionToken: vi.fn(),
    };

    const response = await request(buildApp(repository, fakeRevoker({ revokeAll }))).post(
      "/v1/auth/sessions/revoke-all",
    );

    expect(response.status).toBe(204);
    expect(revokeAll).toHaveBeenCalledWith(expect.any(Object));
  });

  it("revokes every session bound to a device key and reports how many", async () => {
    const revokeByDpopKey = vi.fn().mockResolvedValue(2);
    const repository: CustomerSessionRepository = {
      listForAccount: vi.fn(),
      findOwnedSessionToken: vi.fn(),
    };

    const response = await request(
      buildApp(repository, fakeRevoker({ revokeByDpopKey })),
    ).post("/v1/auth/sessions/devices/jkt_abc123/revoke");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ data: { revoked_count: 2 } });
    expect(revokeByDpopKey).toHaveBeenCalledWith("jkt_abc123", expect.any(Object));
  });
});

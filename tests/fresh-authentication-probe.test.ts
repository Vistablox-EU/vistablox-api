import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import {
  createFreshAuthenticationProbe,
  createRequireFreshAuthentication,
} from "../src/modules/auth/api/customer/require-fresh-authentication.js";
import type { AuthContext } from "../src/modules/auth/api/shared/auth-context.js";
import { FRESH_AUTH_WINDOW_MS } from "../src/modules/auth/domain/fresh-authentication.js";
import type { CustomerSessionRepository } from "../src/modules/auth/repository/customer/customer-session.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");

function context(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    accountId: "acct_01",
    providerSessionId: "session_01",
    population: "customer",
    authenticationLevel: "device_biometric",
    sessionCreatedAt: new Date(NOW.getTime() - 60_000),
    ...overrides,
  };
}

function sessionsWith(verdict: boolean | Error | "absent"): CustomerSessionRepository {
  const base = {
    listForAccount: vi.fn(),
    findOwnedProviderSessionId: vi.fn(),
  };
  if (verdict === "absent") return base;
  return {
    ...base,
    hasFreshAuthentication:
      verdict instanceof Error
        ? vi.fn().mockRejectedValue(verdict)
        : vi.fn().mockResolvedValue(verdict),
  };
}

describe("fresh authentication probe", () => {
  it("is true for a device-biometric customer session inside the window, without touching the repository", async () => {
    const sessions = sessionsWith(false);
    const probe = createFreshAuthenticationProbe(sessions, () => NOW);

    await expect(probe(context())).resolves.toBe(true);
    expect(sessions.hasFreshAuthentication).not.toHaveBeenCalled();
  });

  it("is true exactly at the edge of the window and false one millisecond past it", async () => {
    const sessions = sessionsWith(false);
    const probe = createFreshAuthenticationProbe(sessions, () => NOW);

    await expect(
      probe(context({ sessionCreatedAt: new Date(NOW.getTime() - FRESH_AUTH_WINDOW_MS) })),
    ).resolves.toBe(true);
    await expect(
      probe(context({ sessionCreatedAt: new Date(NOW.getTime() - FRESH_AUTH_WINDOW_MS - 1) })),
    ).resolves.toBe(false);
  });

  it("asks the repository about an older session with freshAfter exactly one window before now, and returns its answer", async () => {
    const stale = context({ sessionCreatedAt: new Date(NOW.getTime() - 10 * 60_000) });

    const negative = sessionsWith(false);
    await expect(createFreshAuthenticationProbe(negative, () => NOW)(stale)).resolves.toBe(false);
    expect(negative.hasFreshAuthentication).toHaveBeenCalledWith({
      accountId: "acct_01",
      providerSessionId: "session_01",
      freshAfter: new Date(NOW.getTime() - FRESH_AUTH_WINDOW_MS),
    });

    const positive = sessionsWith(true);
    await expect(createFreshAuthenticationProbe(positive, () => NOW)(stale)).resolves.toBe(true);
  });

  it("is false when there is no auth context at all, without touching the repository", async () => {
    const sessions = sessionsWith(true);
    const probe = createFreshAuthenticationProbe(sessions, () => NOW);

    await expect(probe(undefined)).resolves.toBe(false);
    expect(sessions.hasFreshAuthentication).not.toHaveBeenCalled();
  });

  it("does not let a staff session at device_biometric level shortcut the check", async () => {
    const sessions = sessionsWith(false);
    const probe = createFreshAuthenticationProbe(sessions, () => NOW);

    await expect(probe(context({ population: "staff_partner" }))).resolves.toBe(false);
    expect(sessions.hasFreshAuthentication).toHaveBeenCalledTimes(1);
  });

  it("is false for a session with no recorded creation time or no authentication level", async () => {
    const sessions = sessionsWith(false);
    const probe = createFreshAuthenticationProbe(sessions, () => NOW);
    const withoutCreation = context();
    delete withoutCreation.sessionCreatedAt;
    const withoutLevel = context();
    delete withoutLevel.authenticationLevel;

    await expect(probe(withoutCreation)).resolves.toBe(false);
    await expect(probe(withoutLevel)).resolves.toBe(false);
  });

  it("fails closed when the repository cannot answer the question", async () => {
    const stale = context({ sessionCreatedAt: new Date(NOW.getTime() - 10 * 60_000) });

    await expect(
      createFreshAuthenticationProbe(sessionsWith("absent"), () => NOW)(stale),
    ).resolves.toBe(false);
  });

  it("rejects, rather than answering true or false, when the repository check errors", async () => {
    const stale = context({ sessionCreatedAt: new Date(NOW.getTime() - 10 * 60_000) });
    const probe = createFreshAuthenticationProbe(sessionsWith(new Error("db down")), () => NOW);

    await expect(probe(stale)).rejects.toThrow("db down");
  });

  describe("agreement with the requireFreshAuthentication middleware", () => {
    const cases: Array<{
      name: string;
      auth: Partial<AuthContext>;
      repositoryVerdict: boolean;
      withoutCreationTime?: boolean;
    }> = [
      { name: "fresh device session", auth: {}, repositoryVerdict: false },
      {
        name: "stale device session, repository says no",
        auth: { sessionCreatedAt: new Date(NOW.getTime() - 6 * 60_000) },
        repositoryVerdict: false,
      },
      {
        name: "stale device session, repository says yes",
        auth: { sessionCreatedAt: new Date(NOW.getTime() - 6 * 60_000) },
        repositoryVerdict: true,
      },
      {
        name: "staff session at device_biometric level, repository says no",
        auth: { population: "staff_partner" },
        repositoryVerdict: false,
      },
      {
        name: "staff session, repository says yes",
        auth: { population: "staff_partner" },
        repositoryVerdict: true,
      },
      {
        name: "customer session without a creation time",
        auth: {},
        repositoryVerdict: false,
        withoutCreationTime: true,
      },
    ];

    for (const testCase of cases) {
      it(`gives the same verdict as the middleware: ${testCase.name}`, async () => {
        const auth = context(testCase.auth);
        if (testCase.withoutCreationTime === true) delete auth.sessionCreatedAt;
        const probeVerdict = await createFreshAuthenticationProbe(
          sessionsWith(testCase.repositoryVerdict),
          () => NOW,
        )(auth);

        const app = express();
        app.use(requestContext);
        app.get(
          "/protected",
          (_request, response, next) => {
            response.locals.authContext = auth;
            next();
          },
          createRequireFreshAuthentication(sessionsWith(testCase.repositoryVerdict), () => NOW),
          (_request, response) => response.json({ ok: true }),
        );
        app.use(errorHandler);
        const middlewareResponse = await request(app).get("/protected");

        expect(middlewareResponse.status).toBe(probeVerdict ? 200 : 403);
      });
    }
  });
});

import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { createRequireFreshAuthentication } from "../src/modules/auth/api/require-fresh-authentication.js";
import type { CustomerSessionRepository } from "../src/modules/auth/repository/customer-session.repository.js";

const NOW = new Date("2026-09-12T12:00:00.000Z");

function runMiddleware(lastFreshAuthAt: Date): Promise<unknown> {
  const sessions: CustomerSessionRepository = {
    listForAccount: vi.fn(),
    findOwnedSessionToken: vi.fn(),
    hasFreshAuthentication: vi.fn().mockImplementation(async ({ freshAfter }) =>
      lastFreshAuthAt >= freshAfter,
    ),
  };
  const middleware = createRequireFreshAuthentication(sessions, () => NOW);
  const response = {
    locals: {
      authContext: {
        accountId: "acct_01",
        providerSessionId: "session_01",
        population: "customer" as const,
      },
    },
  } as Response;

  return new Promise((resolve) => {
    middleware({} as Request, response, (error?: unknown) => resolve(error));
  });
}

describe("require fresh authentication", () => {
  it("accepts a customer MFA verification from within the 15-minute policy window", async () => {
    const error = await runMiddleware(new Date("2026-09-12T11:45:01.000Z"));

    expect(error).toBeUndefined();
  });

  it("requires another MFA verification once the 15-minute policy window has elapsed", async () => {
    const error = await runMiddleware(new Date("2026-09-12T11:44:59.000Z"));

    expect(error).toMatchObject({ code: "authentication.fresh_auth_required", status: 403 });
  });
});

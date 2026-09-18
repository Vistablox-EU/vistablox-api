import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createWalletOperationsRouter } from "../src/modules/wallet/api/wallet-operations.router.js";
import { GetWalletAccountForOperationsService } from "../src/modules/wallet/application/get-wallet-account-for-operations.service.js";
import type { WalletRepository } from "../src/modules/wallet/repository/wallet.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

// This router implements no auth/authorization logic itself -- it only
// composes whatever guard middleware it's given, exactly like every other
// operations router (see intake-operations.router.ts). Guard behavior
// itself is covered by require-staff-role.test.ts; these stand in as
// pass-through/deny stubs so this file can focus on the service wiring and
// response shape.
const allow: RequestHandler = (_request, _response, next) => next();
function deny(status: number, code: string): RequestHandler {
  return (_request, response) => {
    response.status(status).json({ code });
  };
}

function buildApp(options?: {
  repository?: WalletRepository;
  requireAdminOperations?: RequestHandler;
  requireStaffWebAuthn?: RequestHandler;
}) {
  const repository: WalletRepository =
    options?.repository ??
    ({
      registerWallet: vi.fn(),
      findByAccountId: vi.fn().mockImplementation((accountId: string) =>
        Promise.resolve(
          accountId === "acct_01"
            ? {
                walletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
                registrationCommitment: "0xabc123",
                requestedAt: new Date("2026-09-02T10:00:00.000Z"),
                registeredAt: new Date("2026-09-02T10:05:00.000Z"),
              }
            : null,
        ),
      ),
    } satisfies WalletRepository);

  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use(
    "/internal/v1/wallet-accounts",
    createWalletOperationsRouter(
      allow,
      options?.requireAdminOperations ?? allow,
      options?.requireStaffWebAuthn ?? allow,
      new GetWalletAccountForOperationsService(repository),
    ),
  );
  app.use(errorHandler);
  return { app, repository };
}

describe("GET /internal/v1/wallet-accounts/:account_id", () => {
  it("returns the wallet registration for a known account", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/internal/v1/wallet-accounts/acct_01");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      data: {
        account_id: "acct_01",
        wallet_address: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        registration_commitment: "0xabc123",
        status: "registered",
        requested_at: "2026-09-02T10:00:00.000Z",
        registered_at: "2026-09-02T10:05:00.000Z",
      },
    });
  });

  it("reports pending status when the wallet hasn't confirmed on-chain yet", async () => {
    const repository: WalletRepository = {
      registerWallet: vi.fn(),
      findByAccountId: vi.fn().mockResolvedValue({
        walletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        registrationCommitment: "0xabc123",
        requestedAt: new Date("2026-09-02T10:00:00.000Z"),
        registeredAt: null,
      }),
    };
    const { app } = buildApp({ repository });

    const response = await request(app).get("/internal/v1/wallet-accounts/acct_01");

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("pending");
    expect(response.body.data.registered_at).toBeNull();
  });

  it("404s for an account with no registered wallet -- not a synthesized empty response", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/internal/v1/wallet-accounts/acct_missing");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("wallet.account_not_found");
  });

  it("denies the request when the admin-operations guard rejects it", async () => {
    const { app, repository } = buildApp({
      requireAdminOperations: deny(403, "authorization.forbidden"),
    });

    const response = await request(app).get("/internal/v1/wallet-accounts/acct_01");

    expect(response.status).toBe(403);
    expect(repository.findByAccountId).not.toHaveBeenCalled();
  });

  it("denies the request when the staff-WebAuthn guard rejects it", async () => {
    const { app, repository } = buildApp({
      requireStaffWebAuthn: deny(403, "authentication.webauthn_required"),
    });

    const response = await request(app).get("/internal/v1/wallet-accounts/acct_01");

    expect(response.status).toBe(403);
    expect(repository.findByAccountId).not.toHaveBeenCalled();
  });
});

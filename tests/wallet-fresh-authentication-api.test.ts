import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { FRESH_AUTH_WINDOW_MS } from "../src/modules/auth/domain/fresh-authentication.js";
import {
  WalletReplacementFreshAuthenticationRequiredError,
  type WalletRepository,
} from "../src/modules/wallet/repository/wallet.repository.js";
import { buildWalletFreshAuthApp, REGISTRY_ADDRESS } from "./support/wallet-fresh-auth-app.js";

const ADDRESS = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";
const NOW = Date.now();

function walletRepository(overrides: Partial<WalletRepository> = {}): WalletRepository {
  return {
    registerWallet: vi.fn().mockResolvedValue({
      walletAddress: ADDRESS,
      registrationCommitment: "0xcommitment",
      requestedAt: new Date("2026-09-02T10:00:00.000Z"),
      registeredAt: null,
    }),
    findByAccountId: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const post = (app: ReturnType<ReturnType<typeof buildWalletFreshAuthApp>["build"]>) =>
  request(app).post("/v1/investor-profile/wallet").send({ wallet_address: ADDRESS });

describe("POST /v1/investor-profile/wallet with the real fresh-authentication wiring", () => {
  it("gives the repository freshAuthentication: true for a device session created a minute ago", async () => {
    const repository = walletRepository();
    const { build, customerSessionRepository } = buildWalletFreshAuthApp({ walletRepository: repository });

    const response = await post(build());

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ registry_contract_address: REGISTRY_ADDRESS, status: "pending" });
    expect(repository.registerWallet).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_wallet_fa", freshAuthentication: true }),
    );
    expect(customerSessionRepository.hasFreshAuthentication).not.toHaveBeenCalled();
  });

  it("gives the repository freshAuthentication: false for a device session older than the window, after one repository lookup", async () => {
    const repository = walletRepository();
    const { build, customerSessionRepository } = buildWalletFreshAuthApp({
      walletRepository: repository,
      identity: { sessionCreatedAt: new Date(NOW - 10 * 60_000) },
    });

    const response = await post(build());

    expect(response.status).toBe(201);
    expect(repository.registerWallet).toHaveBeenCalledWith(
      expect.objectContaining({ freshAuthentication: false }),
    );
    expect(customerSessionRepository.hasFreshAuthentication).toHaveBeenCalledTimes(1);
    const lookup = vi.mocked(customerSessionRepository.hasFreshAuthentication!).mock.calls[0]![0];
    expect(lookup).toMatchObject({ accountId: "acct_wallet_fa", providerSessionId: "session_wallet_fa" });
    expect(Math.abs(lookup.freshAfter.getTime() - (Date.now() - FRESH_AUTH_WINDOW_MS))).toBeLessThan(5_000);
  });

  it("gives false when the session has no authentication level, however recent it is", async () => {
    const repository = walletRepository();
    const { build } = buildWalletFreshAuthApp({
      walletRepository: repository,
      identity: { sessionCreatedAt: new Date(NOW - 1_000) },
      omitAuthenticationLevel: true,
    });

    await post(build());

    expect(repository.registerWallet).toHaveBeenCalledWith(
      expect.objectContaining({ freshAuthentication: false }),
    );
  });

  it("gives false for a recent session at a level other than device_biometric", async () => {
    const repository = walletRepository();
    const { build } = buildWalletFreshAuthApp({
      walletRepository: repository,
      identity: { sessionCreatedAt: new Date(NOW - 1_000), authenticationLevel: "password" },
    });

    await post(build());

    expect(repository.registerWallet).toHaveBeenCalledWith(
      expect.objectContaining({ freshAuthentication: false }),
    );
  });

  it("gives true when the session is outside the window but the repository vouches for it", async () => {
    const repository = walletRepository();
    const { build } = buildWalletFreshAuthApp({
      walletRepository: repository,
      identity: { sessionCreatedAt: new Date(NOW - 10 * 60_000) },
      hasFreshAuthentication: vi.fn().mockResolvedValue(true),
    });

    await post(build());

    expect(repository.registerWallet).toHaveBeenCalledWith(
      expect.objectContaining({ freshAuthentication: true }),
    );
  });

  it("is not made fresh by a request field, query parameter or header", async () => {
    const repository = walletRepository();
    const { build } = buildWalletFreshAuthApp({
      walletRepository: repository,
      identity: { sessionCreatedAt: new Date(NOW - 10 * 60_000) },
    });

    await request(build())
      .post("/v1/investor-profile/wallet?fresh=1")
      .set("X-Fresh-Authentication", "1")
      .send({ wallet_address: ADDRESS, fresh_authentication: true });

    expect(repository.registerWallet).toHaveBeenCalledWith(
      expect.objectContaining({ freshAuthentication: false }),
    );
  });

  it("answers a refused replacement with exactly the documented 403 envelope", async () => {
    const repository = walletRepository({
      registerWallet: vi.fn().mockRejectedValue(new WalletReplacementFreshAuthenticationRequiredError()),
    });
    const { build } = buildWalletFreshAuthApp({
      walletRepository: repository,
      identity: { sessionCreatedAt: new Date(NOW - 10 * 60_000) },
    });

    const response = await post(build());

    expect(response.status).toBe(403);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(Object.keys(response.body).sort()).toEqual(["code", "detail", "status", "title", "trace_id", "type"]);
    expect(response.body.type).toBe("https://api.vistablox.io/errors/authentication.fresh_auth_required");
    expect(response.body.code).toBe("authentication.fresh_auth_required");
    expect(response.body.title).toBe("Fresh authentication required");
    expect(response.body.status).toBe(403);
    expect(response.body.detail).toBe("Sign in again on this device before continuing.");
    expect(typeof response.body.trace_id).toBe("string");
    expect(response.body.trace_id.length).toBeGreaterThan(0);
    expect(response.body).not.toHaveProperty("field_errors");
  });

  it("refuses to be constructed with a wallet and no customer-session repository, rather than refusing every replacement later", () => {
    const { build } = buildWalletFreshAuthApp({
      walletRepository: walletRepository(),
      omitCustomerSessions: true,
    });

    expect(build).toThrow(/protectedApi\.wallet requires protectedApi\.customerSessions/);
  });

  it("still requires an authenticated session at all", async () => {
    const repository = walletRepository();
    const { build, sessions } = buildWalletFreshAuthApp({ walletRepository: repository });
    vi.mocked(sessions.resolve).mockResolvedValue(null);

    const response = await post(build());

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("authentication.required");
    expect(repository.registerWallet).not.toHaveBeenCalled();
  });
});

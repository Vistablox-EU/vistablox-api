import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createWalletRouter } from "../src/modules/wallet/api/wallet.router.js";
import { RegisterWalletService } from "../src/modules/wallet/application/register-wallet.service.js";
import { GetWalletBalanceService } from "../src/modules/wallet/application/get-wallet-balance.service.js";
import { RequestWalletTransferService } from "../src/modules/wallet/application/request-wallet-transfer.service.js";
import type { WalletRepository } from "../src/modules/wallet/repository/wallet.repository.js";
import type { KycEligibilityReader } from "../src/modules/identity/repository/kyc-eligibility-reader.js";
import type { PivTokenHoldingsReader } from "../src/modules/settlement/repository/settlement.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const eligibleKyc = {
  accountId: "acct_01",
  diditReference: null,
  providerStatus: null,
  eligibilityState: "eligible" as const,
  residenceCountryCode: "DE",
  taxResidenceCountryCode: "DE",
  proofOfAddressStatus: "current" as const,
  proofOfAddressCurrentUntil: new Date("2099-01-01T00:00:00.000Z"),
  lastVerifiedAt: new Date("2026-08-01T12:00:00.000Z"),
  renewalDueAt: new Date("2099-01-01T00:00:00.000Z"),
};

function buildApp(options?: {
  kyc?: typeof eligibleKyc | null;
  registerWallet?: WalletRepository["registerWallet"];
}) {
  const repository: WalletRepository = {
    registerWallet:
      options?.registerWallet ??
      vi.fn().mockResolvedValue({
        walletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        registrationCommitment: "commitment_01",
        requestedAt: new Date("2026-09-02T10:00:00.000Z"),
        registeredAt: null,
      }),
    findByAccountId: vi.fn().mockResolvedValue(null),
  };
  const kycEligibilityReader: KycEligibilityReader = {
    getEligibilitySnapshot: vi
      .fn()
      .mockResolvedValue(options !== undefined && "kyc" in options ? options.kyc : eligibleKyc),
  };

  const app = express();
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = {
      accountId: "acct_01",
      providerSessionId: "session_01",
      population: "customer",
    };
    next();
  };
  app.use(requestContext);
  app.use(express.json());
  app.use(
    "/v1/investor-profile/wallet",
    createWalletRouter(
      authenticated,
      new RegisterWalletService(
        repository,
        kycEligibilityReader,
        () => new Date("2026-09-02T10:00:00.000Z"),
      ),
    ),
  );
  app.use(errorHandler);
  return { app, repository };
}

describe("POST /v1/investor-profile/wallet", () => {
  const validAddress = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

  it("registers a wallet address for a KYC-eligible investor", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet")
      .send({ wallet_address: validAddress });

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      data: {
        wallet_address: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        registration_commitment: "commitment_01",
        status: "pending",
        requested_at: "2026-09-02T10:00:00.000Z",
        registered_at: null,
      },
    });
    expect(repository.registerWallet).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_01", walletAddress: validAddress }),
    );
  });

  it("rejects a malformed wallet address before touching the repository", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet")
      .send({ wallet_address: "not-an-address" });

    expect(response.status).toBe(422);
    expect(repository.registerWallet).not.toHaveBeenCalled();
  });

  it("requires current KYC eligibility", async () => {
    const { app, repository } = buildApp({ kyc: null });

    const response = await request(app)
      .post("/v1/investor-profile/wallet")
      .send({ wallet_address: validAddress });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("identity.kyc_required");
    expect(repository.registerWallet).not.toHaveBeenCalled();
  });

  it("reports a conflict when the address is already claimed by another account", async () => {
    const { WalletAddressConflictError } = await import(
      "../src/modules/wallet/repository/wallet.repository.js"
    );
    const { app } = buildApp({
      registerWallet: vi.fn().mockRejectedValue(new WalletAddressConflictError("address_claimed")),
    });

    const response = await request(app)
      .post("/v1/investor-profile/wallet")
      .send({ wallet_address: validAddress });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("wallet.address_already_claimed");
  });
});

describe("GET /v1/investor-profile/wallet", () => {
  function buildBalanceApp(options?: { balanceService?: GetWalletBalanceService }) {
    const repository: WalletRepository = {
      registerWallet: vi.fn(),
      findByAccountId: vi.fn().mockResolvedValue({
        walletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        registrationCommitment: "commitment_01",
        requestedAt: new Date("2026-09-02T10:00:00.000Z"),
        registeredAt: new Date("2026-09-02T10:05:00.000Z"),
      }),
    };
    const holdingsReader: PivTokenHoldingsReader = {
      listTokenHoldings: vi.fn().mockResolvedValue([{ pivId: "piv_01", tokenId: "7" }]),
    };
    const balanceService =
      options?.balanceService ??
      new GetWalletBalanceService(repository, holdingsReader, {
        getCapitalBalance: vi.fn().mockResolvedValue(1_250_000_000n),
        getTokenBalances: vi.fn().mockResolvedValue([3n]),
      });

    const app = express();
    const authenticated: RequestHandler = (_request, response, next) => {
      response.locals.authContext = {
        accountId: "acct_01",
        providerSessionId: "session_01",
        population: "customer",
      };
      next();
    };
    app.use(requestContext);
    app.use(express.json());
    app.use(
      "/v1/investor-profile/wallet",
      createWalletRouter(
        authenticated,
        new RegisterWalletService(repository, { getEligibilitySnapshot: vi.fn() }),
        balanceService,
      ),
    );
    app.use(errorHandler);
    return { app };
  }

  it("reads the registered wallet's capital and token balances", async () => {
    const { app } = buildBalanceApp();

    const response = await request(app).get("/v1/investor-profile/wallet");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      data: {
        wallet_address: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        capital_eurc: "1250.000000",
        tokens: [{ piv_id: "piv_01", token_id: "7", balance: "3" }],
      },
    });
  });

  it("is not mounted when no balance service is configured", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/v1/investor-profile/wallet");

    expect(response.status).toBe(404);
  });
});

describe("POST /v1/investor-profile/wallet/transfers", () => {
  const toWalletAddress = "0x00000000219ab540356cbb839cbe05303d7705fa";

  function buildTransferApp(options?: { transferService?: RequestWalletTransferService }) {
    const repository: WalletRepository = {
      registerWallet: vi.fn(),
      findByAccountId: vi.fn().mockResolvedValue({
        walletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        registrationCommitment: "commitment_01",
        requestedAt: new Date("2026-09-02T10:00:00.000Z"),
        registeredAt: new Date("2026-09-02T10:05:00.000Z"),
      }),
    };
    const holdingsReader: PivTokenHoldingsReader = {
      listTokenHoldings: vi.fn().mockResolvedValue([{ pivId: "piv_01", tokenId: "7" }]),
    };
    const transferService =
      options?.transferService ??
      new RequestWalletTransferService(repository, holdingsReader, {
        getTokenBalance: vi.fn().mockResolvedValue(10n),
        isHolderAuthorized: vi.fn().mockResolvedValue(true),
        isTokenPaused: vi.fn().mockResolvedValue(false),
        buildTransferRequest: vi.fn().mockReturnValue({
          chainId: 84532,
          to: "0xproperty",
          data: "0xdeadbeef",
          value: "0",
        }),
      });

    const app = express();
    const authenticated: RequestHandler = (_request, response, next) => {
      response.locals.authContext = {
        accountId: "acct_01",
        providerSessionId: "session_01",
        population: "customer",
      };
      next();
    };
    app.use(requestContext);
    app.use(express.json());
    app.use(
      "/v1/investor-profile/wallet",
      createWalletRouter(
        authenticated,
        new RegisterWalletService(repository, { getEligibilitySnapshot: vi.fn() }),
        undefined,
        transferService,
      ),
    );
    app.use(errorHandler);
    return { app };
  }

  it("builds an unsigned transfer transaction for the caller's wallet", async () => {
    const { app } = buildTransferApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: toWalletAddress, amount: "3" });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      data: {
        piv_id: "piv_01",
        token_id: "7",
        amount: "3",
        from_wallet_address: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        to_wallet_address: toWalletAddress,
        unsigned_transaction: { chain_id: 84532, to: "0xproperty", data: "0xdeadbeef", value: "0" },
      },
    });
  });

  it("rejects a malformed recipient address before touching the chain", async () => {
    const { app } = buildTransferApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: "not-an-address", amount: "3" });

    expect(response.status).toBe(422);
  });

  it("is not mounted when no transfer service is configured", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: toWalletAddress, amount: "3" });

    expect(response.status).toBe(404);
  });
});

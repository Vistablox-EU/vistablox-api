import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createWalletRouter } from "../src/modules/wallet/api/wallet.router.js";
import { requestWalletTransferResponseSchema } from "../src/modules/wallet/api/wallet.schemas.js";
import { RegisterWalletService } from "../src/modules/wallet/application/register-wallet.service.js";
import { GetWalletBalanceService } from "../src/modules/wallet/application/get-wallet-balance.service.js";
import { GetWalletStatusService } from "../src/modules/wallet/application/get-wallet-status.service.js";
import { RequestWalletTransferService } from "../src/modules/wallet/application/request-wallet-transfer.service.js";
import type { WalletRepository } from "../src/modules/wallet/repository/wallet.repository.js";
import type { KycEligibilityReader } from "../src/modules/identity/repository/kyc-eligibility-reader.js";
import type { PivTokenHoldingsReader } from "../src/modules/settlement/repository/settlement.repository.js";
import { ChainStateUnavailableError } from "../src/shared/errors/chain-state-unavailable-error.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";
import {
  SNAPSHOT_BLOCK_HASH,
  buildPassingSnapshot,
  buildTransferChainReader,
} from "./support/wallet-transfer-fakes.js";

const TEST_REGISTRY_ADDRESS = "0x1234567890123456789012345678901234567890";

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
        TEST_REGISTRY_ADDRESS,
        () => new Date("2026-09-02T10:00:00.000Z"),
      ),
      new GetWalletStatusService(repository),
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
        registry_contract_address: TEST_REGISTRY_ADDRESS,
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
  it("reads the registered wallet's address and status without needing a balance service", async () => {
    const repository: WalletRepository = {
      registerWallet: vi.fn(),
      findByAccountId: vi.fn().mockResolvedValue({
        walletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        registrationCommitment: "commitment_01",
        requestedAt: new Date("2026-09-02T10:00:00.000Z"),
        registeredAt: new Date("2026-09-02T10:05:00.000Z"),
      }),
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
        new RegisterWalletService(repository, { getEligibilitySnapshot: vi.fn() }, TEST_REGISTRY_ADDRESS),
        new GetWalletStatusService(repository),
      ),
    );
    app.use(errorHandler);

    const response = await request(app).get("/v1/investor-profile/wallet");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      data: {
        wallet_address: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        status: "registered",
        requested_at: "2026-09-02T10:00:00.000Z",
        registered_at: "2026-09-02T10:05:00.000Z",
      },
    });
  });

  it("404s when the account has no registered wallet", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/v1/investor-profile/wallet");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("wallet.not_registered");
  });
});

describe("GET /v1/investor-profile/wallet/balance", () => {
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
        new RegisterWalletService(repository, { getEligibilitySnapshot: vi.fn() }, TEST_REGISTRY_ADDRESS),
        new GetWalletStatusService(repository),
        balanceService,
      ),
    );
    app.use(errorHandler);
    return { app };
  }

  it("reads the registered wallet's capital and token balances", async () => {
    const { app } = buildBalanceApp();

    const response = await request(app).get("/v1/investor-profile/wallet/balance");

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

    const response = await request(app).get("/v1/investor-profile/wallet/balance");

    expect(response.status).toBe(404);
  });
});

describe("POST /v1/investor-profile/wallet/transfers", () => {
  const toWalletAddress = "0x00000000219ab540356cbb839cbe05303d7705fa";

  function buildTransferApp(options?: {
    transferService?: RequestWalletTransferService;
    chainReader?: ReturnType<typeof buildTransferChainReader>;
    // The wallet row's registered_at. Defaults to a confirmed registration;
    // pass null for a pending claim.
    registeredAt?: Date | null;
  }) {
    const repository: WalletRepository = {
      registerWallet: vi.fn(),
      findByAccountId: vi.fn().mockResolvedValue({
        walletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        registrationCommitment: "commitment_01",
        requestedAt: new Date("2026-09-02T10:00:00.000Z"),
        registeredAt:
          options !== undefined && "registeredAt" in options
            ? options.registeredAt
            : new Date("2026-09-02T10:05:00.000Z"),
      }),
    };
    const holdingsReader: PivTokenHoldingsReader = {
      listTokenHoldings: vi.fn().mockResolvedValue([{ pivId: "piv_01", tokenId: "7" }]),
    };
    const chainReader = options?.chainReader ?? buildTransferChainReader();
    const transferService =
      options?.transferService ??
      new RequestWalletTransferService(repository, holdingsReader, chainReader);

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
        new RegisterWalletService(repository, { getEligibilitySnapshot: vi.fn() }, TEST_REGISTRY_ADDRESS),
        new GetWalletStatusService(repository),
        undefined,
        transferService,
      ),
    );
    app.use(errorHandler);
    return { app, chainReader, holdingsReader };
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
        preflight: {
          block_number: "123456",
          block_hash: SNAPSHOT_BLOCK_HASH,
          sender_balance: "10",
          recipient_authorized: true,
          token_paused: false,
          simulation: "passed",
        },
      },
    });
  });

  it("returns the block the preview was read at, as strings, and the response schema does not strip it", async () => {
    const { app } = buildTransferApp({
      chainReader: buildTransferChainReader(
        buildPassingSnapshot({
          block: { number: 2n ** 60n, hash: `0x${"0f".repeat(32)}` },
          senderBalance: 2n ** 70n,
        }),
      ),
    });

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: toWalletAddress, amount: "3" });

    expect(response.status).toBe(200);
    expect(response.body.data.preflight).toEqual({
      block_number: (2n ** 60n).toString(),
      block_hash: `0x${"0f".repeat(32)}`,
      sender_balance: (2n ** 70n).toString(),
      recipient_authorized: true,
      token_paused: false,
      simulation: "passed",
    });
  });

  it("answers 422 wallet.transfer_lane_closed in the documented envelope while the contract's lane is closed", async () => {
    const { app } = buildTransferApp({
      chainReader: buildTransferChainReader(
        buildPassingSnapshot({
          simulation: { status: "reverted", revert: { errorName: "TransferLaneClosed" } },
        }),
      ),
    });

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: toWalletAddress, amount: "3" });

    expect(response.status).toBe(422);
    expect(Object.keys(response.body).sort()).toEqual(["code", "detail", "status", "title", "trace_id", "type"]);
    expect(response.body).toMatchObject({
      code: "wallet.transfer_lane_closed",
      title: "Transfers not open",
      status: 422,
    });
    expect(response.body.unsigned_transaction).toBeUndefined();
    expect(response.body.data).toBeUndefined();
  });

  it("answers 503 wallet.chain_unavailable, not 500, when the chain cannot be read", async () => {
    const { app } = buildTransferApp({
      chainReader: buildTransferChainReader(() =>
        Promise.reject(new ChainStateUnavailableError("HttpRequestError: HTTP request failed.")),
      ),
    });

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: toWalletAddress, amount: "3" });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: "wallet.chain_unavailable",
      title: "Chain state unavailable",
      status: 503,
    });
    expect(Object.keys(response.body).sort()).toEqual(["code", "detail", "status", "title", "trace_id", "type"]);
  });

  it("answers 422, not 200, when the snapshot says the token is paused", async () => {
    const { app } = buildTransferApp({
      chainReader: buildTransferChainReader(buildPassingSnapshot({ tokenPaused: true })),
    });

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: toWalletAddress, amount: "3" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("wallet.token_paused");
  });

  it("answers 404 wallet.not_registered in the documented envelope for a pending wallet claim, and prepares nothing", async () => {
    const { app, chainReader, holdingsReader } = buildTransferApp({ registeredAt: null });

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: toWalletAddress, amount: "3" });

    expect(response.status).toBe(404);
    expect(Object.keys(response.body).sort()).toEqual(["code", "detail", "status", "title", "trace_id", "type"]);
    expect(response.body).toMatchObject({
      type: "https://api.vistablox.io/errors/wallet.not_registered",
      code: "wallet.not_registered",
      title: "Wallet not registered",
      status: 404,
    });
    expect(response.body.data).toBeUndefined();
    expect(response.body.unsigned_transaction).toBeUndefined();
    expect(holdingsReader.listTokenHoldings).not.toHaveBeenCalled();
    expect(chainReader.readTransferSnapshot).not.toHaveBeenCalled();
  });

  it("answers a malformed body 422 before it looks at the wallet, so a pending claim is not revealed by it", async () => {
    const { app, chainReader } = buildTransferApp({ registeredAt: null });

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: "not-an-address", amount: "3" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("validation.invalid_field");
    expect(chainReader.readTransferSnapshot).not.toHaveBeenCalled();
  });

  it("keeps GET /v1/investor-profile/wallet reporting the pending claim, so a client can tell it from no wallet", async () => {
    const { app } = buildTransferApp({ registeredAt: null });

    const response = await request(app).get("/v1/investor-profile/wallet");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        wallet_address: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        status: "pending",
        requested_at: "2026-09-02T10:00:00.000Z",
        registered_at: null,
      },
    });
  });

  it("has a response schema that cannot carry a preview saying no", () => {
    const body = {
      data: {
        piv_id: "piv_01",
        token_id: "7",
        amount: "3",
        from_wallet_address: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        to_wallet_address: toWalletAddress,
        unsigned_transaction: { chain_id: 84532, to: "0xproperty", data: "0xdeadbeef", value: "0" },
        preflight: {
          block_number: "1",
          block_hash: SNAPSHOT_BLOCK_HASH,
          sender_balance: "10",
          recipient_authorized: true,
          token_paused: false,
          simulation: "passed",
        },
      },
    };
    expect(requestWalletTransferResponseSchema.safeParse(body).success).toBe(true);
    for (const override of [
      { recipient_authorized: false },
      { token_paused: true },
      { simulation: "reverted" },
      { block_hash: "0xABC" },
      { block_number: "-1" },
    ]) {
      const broken = { data: { ...body.data, preflight: { ...body.data.preflight, ...override } } };
      expect(requestWalletTransferResponseSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("rejects a malformed recipient address before touching the chain", async () => {
    const { app, chainReader } = buildTransferApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: "not-an-address", amount: "3" });

    expect(response.status).toBe(422);
    expect(chainReader.readTransferSnapshot).not.toHaveBeenCalled();
  });

  it("is not mounted when no transfer service is configured", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: toWalletAddress, amount: "3" });

    expect(response.status).toBe(404);
  });
});

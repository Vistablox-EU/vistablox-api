import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createWalletRouter, type WalletFreshAuthenticationProbe } from "../src/modules/wallet/api/wallet.router.js";
import { RegisterWalletService } from "../src/modules/wallet/application/register-wallet.service.js";
import { GetWalletBalanceService } from "../src/modules/wallet/application/get-wallet-balance.service.js";
import { GetWalletStatusService } from "../src/modules/wallet/application/get-wallet-status.service.js";
import { RequestWalletTransferService } from "../src/modules/wallet/application/request-wallet-transfer.service.js";
import {
  WalletAddressConflictError,
  WalletReplacementFreshAuthenticationRequiredError,
  type WalletRepository,
} from "../src/modules/wallet/repository/wallet.repository.js";
import type { KycEligibilityReader } from "../src/modules/identity/repository/kyc-eligibility-reader.js";
import type { PivTokenHoldingsReader } from "../src/modules/settlement/repository/settlement.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

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

// A probe for the tests that do not care about freshness.
const notFresh: WalletFreshAuthenticationProbe = async () => false;

function buildApp(options?: {
  kyc?: typeof eligibleKyc | null;
  registerWallet?: WalletRepository["registerWallet"];
  probe?: WalletFreshAuthenticationProbe;
  population?: "customer" | "staff_partner";
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
      population: options?.population ?? "customer",
    };
    next();
  };
  app.use(requestContext);
  app.use(express.json());
  app.use(
    "/v1/investor-profile/wallet",
    createWalletRouter(
      authenticated,
      options?.probe ?? notFresh,
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
  return { app, repository, kycEligibilityReader };
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

describe("POST /v1/investor-profile/wallet freshness", () => {
  const validAddress = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
  const post = (app: express.Express) =>
    request(app).post("/v1/investor-profile/wallet").send({ wallet_address: validAddress });

  it("passes the probe's true to the service as freshAuthentication: true", async () => {
    const { app, repository } = buildApp({ probe: vi.fn().mockResolvedValue(true) });

    const response = await post(app);

    expect(response.status).toBe(201);
    expect(repository.registerWallet).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_01", freshAuthentication: true }),
    );
  });

  it("passes the probe's false to the service as freshAuthentication: false", async () => {
    const { app, repository } = buildApp({ probe: vi.fn().mockResolvedValue(false) });

    await post(app);

    expect(repository.registerWallet).toHaveBeenCalledWith(
      expect.objectContaining({ freshAuthentication: false }),
    );
  });

  it.each([undefined, null, "true", 1, {}])(
    "treats a probe answer of %j as not fresh, so only the boolean true counts",
    async (loose) => {
      const { app, repository } = buildApp({
        probe: vi.fn().mockResolvedValue(loose) as unknown as WalletFreshAuthenticationProbe,
      });

      await post(app);

      expect(repository.registerWallet).toHaveBeenCalledWith(
        expect.objectContaining({ freshAuthentication: false }),
      );
    },
  );

  it("asks the probe about the server-set auth context, exactly once", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const { app } = buildApp({ probe });

    await post(app);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith({
      accountId: "acct_01",
      providerSessionId: "session_01",
      population: "customer",
    });
  });

  it("cannot be made fresh by anything the client sends: body field, query string or header", async () => {
    const { app, repository } = buildApp({ probe: vi.fn().mockResolvedValue(false) });

    const response = await request(app)
      .post("/v1/investor-profile/wallet?fresh=1&fresh_authentication=true")
      .set("X-Fresh-Authentication", "1")
      .set("Fresh-Authentication", "true")
      .send({ wallet_address: validAddress, fresh_authentication: true, freshAuthentication: true });

    expect(response.status).toBe(201);
    expect(repository.registerWallet).toHaveBeenCalledWith(
      expect.objectContaining({ freshAuthentication: false }),
    );
  });

  it("fails closed with a 500 and writes nothing when the probe itself fails", async () => {
    const { app, repository, kycEligibilityReader } = buildApp({
      probe: vi.fn().mockRejectedValue(new Error("session store down")),
    });

    const response = await post(app);

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("internal.unexpected");
    expect(kycEligibilityReader.getEligibilitySnapshot).not.toHaveBeenCalled();
    expect(repository.registerWallet).not.toHaveBeenCalled();
  });

  it("does not call the probe for a body that fails validation", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const { app, repository } = buildApp({ probe });

    const response = await request(app)
      .post("/v1/investor-profile/wallet")
      .send({ wallet_address: "not-an-address" });

    expect(response.status).toBe(422);
    expect(probe).not.toHaveBeenCalled();
    expect(repository.registerWallet).not.toHaveBeenCalled();
  });

  it("does not call the probe for a staff session, which is refused first", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const { app, repository } = buildApp({ probe, population: "staff_partner" });

    const response = await post(app);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
    expect(probe).not.toHaveBeenCalled();
    expect(repository.registerWallet).not.toHaveBeenCalled();
  });

  it("answers a refused replacement with the 403 fresh-authentication envelope and nothing else", async () => {
    const { app } = buildApp({
      registerWallet: vi.fn().mockRejectedValue(new WalletReplacementFreshAuthenticationRequiredError()),
    });

    const response = await post(app);

    expect(response.status).toBe(403);
    expect(Object.keys(response.body).sort()).toEqual(["code", "detail", "status", "title", "trace_id", "type"]);
    expect(response.body).toMatchObject({
      type: "https://api.vistablox.io/errors/authentication.fresh_auth_required",
      code: "authentication.fresh_auth_required",
      title: "Fresh authentication required",
      status: 403,
      detail: "Sign in again on this device before continuing.",
    });
    expect(typeof response.body.trace_id).toBe("string");
    expect(response.body.trace_id.length).toBeGreaterThan(0);
  });

  it("keeps a registration conflict a 409, whatever the probe said", async () => {
    for (const fresh of [true, false]) {
      const { app } = buildApp({
        probe: vi.fn().mockResolvedValue(fresh),
        registerWallet: vi.fn().mockRejectedValue(new WalletAddressConflictError("address_mismatch")),
      });

      const response = await post(app);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("wallet.registration_address_mismatch");
    }
  });

  // The balance and transfer routes have their own "never asks the
  // fresh-authentication probe" tests below, where those routes are mounted.
  it("never asks the probe on the status read", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const { app } = buildApp({ probe });

    const response = await request(app).get("/v1/investor-profile/wallet");

    // The read handler ran (this account has no wallet yet), not a 404 for a missing route.
    expect(response.body.code).toBe("wallet.not_registered");
    expect(probe).not.toHaveBeenCalled();
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
        notFresh,
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

    const probe = vi.fn().mockResolvedValue(true);
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
        probe,
        new RegisterWalletService(repository, { getEligibilitySnapshot: vi.fn() }, TEST_REGISTRY_ADDRESS),
        new GetWalletStatusService(repository),
        balanceService,
      ),
    );
    app.use(errorHandler);
    return { app, probe };
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

  it("never asks the fresh-authentication probe", async () => {
    const { app, probe } = buildBalanceApp();

    await request(app).get("/v1/investor-profile/wallet/balance");

    expect(probe).not.toHaveBeenCalled();
  });

  it("is not mounted when no balance service is configured", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/v1/investor-profile/wallet/balance");

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

    const probe = vi.fn().mockResolvedValue(true);
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
        probe,
        new RegisterWalletService(repository, { getEligibilitySnapshot: vi.fn() }, TEST_REGISTRY_ADDRESS),
        new GetWalletStatusService(repository),
        undefined,
        transferService,
      ),
    );
    app.use(errorHandler);
    return { app, probe };
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

  it("never asks the fresh-authentication probe", async () => {
    const { app, probe } = buildTransferApp();

    await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: toWalletAddress, amount: "3" });

    expect(probe).not.toHaveBeenCalled();
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

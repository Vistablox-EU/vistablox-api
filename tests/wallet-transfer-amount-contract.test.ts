import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createWalletRouter } from "../src/modules/wallet/api/wallet.router.js";
import { RegisterWalletService } from "../src/modules/wallet/application/register-wallet.service.js";
import { GetWalletStatusService } from "../src/modules/wallet/application/get-wallet-status.service.js";
import { RequestWalletTransferService } from "../src/modules/wallet/application/request-wallet-transfer.service.js";
import type { WalletRepository } from "../src/modules/wallet/repository/wallet.repository.js";
import type { PivTokenHoldingsReader } from "../src/modules/settlement/repository/settlement.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";
import { buildPassingSnapshot, buildTransferChainReader } from "./support/wallet-transfer-fakes.js";

// Locks in the amount semantics documented in docs/investor-profile.md
// ("Amount unit and range"): a raw ERC-1155 integer, passed through unchanged.

const MAX_UINT256 = (2n ** 256n - 1n).toString();
const TO = "0x00000000219ab540356cbb839cbe05303d7705fa";

function buildApp(chainReader = buildTransferChainReader()) {
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
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = { accountId: "acct_01", providerSessionId: "s", population: "customer" };
    next();
  };
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use(
    "/v1/investor-profile/wallet",
    createWalletRouter(
      authenticated,
      vi.fn().mockResolvedValue(true),
      new RegisterWalletService(repository, { getEligibilitySnapshot: vi.fn() }, "0x1234567890123456789012345678901234567890"),
      new GetWalletStatusService(repository),
      undefined,
      new RequestWalletTransferService(repository, holdingsReader, chainReader),
    ),
  );
  app.use(errorHandler);
  return { app, chainReader };
}

function post(app: express.Express, amount: unknown) {
  return request(app)
    .post("/v1/investor-profile/wallet/transfers")
    .send({ piv_id: "piv_01", to_wallet_address: TO, amount });
}

describe("transfer amount contract", () => {
  it.each(["0", "007", "-1", "1.5", "1e3", " 1", "1 ", "0x10", "", 3, 1.5, null])(
    "rejects %j as 422 validation.invalid_field on amount, before any chain read",
    async (amount) => {
      const { app, chainReader } = buildApp();
      const response = await post(app, amount);

      expect(response.status).toBe(422);
      expect(response.body.code).toBe("validation.invalid_field");
      expect(response.body.field_errors?.[0]?.field).toBe("amount");
      expect(chainReader.readTransferSnapshot).not.toHaveBeenCalled();
    },
  );

  it("passes the raw integer string to the chain reader unscaled and echoes it", async () => {
    const chainReader = buildTransferChainReader(buildPassingSnapshot({ senderBalance: 250_000_000n }));
    const { app } = buildApp(chainReader);

    const response = await post(app, "250000000");

    expect(response.status).toBe(200);
    expect(response.body.data.amount).toBe("250000000");
    expect(response.body.data.preflight.sender_balance).toBe("250000000");
    expect(chainReader.readTransferSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ amount: "250000000", tokenId: "7" }),
    );
  });

  it("accepts the smallest amount, 1, and the whole balance", async () => {
    const { app } = buildApp();
    expect((await post(app, "1")).status).toBe(200);
    expect((await post(app, "10")).status).toBe(200);
  });

  it("answers 422 wallet.insufficient_balance for an amount above the balance", async () => {
    const { app } = buildApp();
    const response = await post(app, "11");

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("wallet.insufficient_balance");
  });

  it("answers an amount above uint256 as insufficient_balance without a chain read", async () => {
    const { app, chainReader } = buildApp();
    const response = await post(app, (2n ** 256n).toString());

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("wallet.insufficient_balance");
    expect(chainReader.readTransferSnapshot).not.toHaveBeenCalled();
  });

  it("reaches the chain for exactly 2^256 - 1", async () => {
    const { app, chainReader } = buildApp();
    const response = await post(app, MAX_UINT256);

    expect(chainReader.readTransferSnapshot).toHaveBeenCalledOnce();
    expect(response.body.code).toBe("wallet.insufficient_balance");
  });

  it("returns the prepared transaction as unsigned: no signature or hash fields", async () => {
    const { app } = buildApp();
    const response = await post(app, "3");

    expect(response.status).toBe(200);
    expect(Object.keys(response.body.data.unsigned_transaction).sort()).toEqual(["chain_id", "data", "to", "value"]);
    expect(Object.keys(response.body.data).sort()).toEqual([
      "amount",
      "from_wallet_address",
      "piv_id",
      "preflight",
      "to_wallet_address",
      "token_id",
      "unsigned_transaction",
    ]);
  });
});

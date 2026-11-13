import type { Server } from "node:http";
import { Writable } from "node:stream";

import express, { type RequestHandler } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChainReader } from "../src/infrastructure/blockchain/chain-client.js";
import { ViemWalletChainReader } from "../src/infrastructure/blockchain/chain-wallet-reader.js";
import { createLogger } from "../src/infrastructure/logging/logger.js";
import { createWalletRouter } from "../src/modules/wallet/api/wallet.router.js";
import { GetWalletStatusService } from "../src/modules/wallet/application/get-wallet-status.service.js";
import { RegisterWalletService } from "../src/modules/wallet/application/register-wallet.service.js";
import { RequestWalletTransferService } from "../src/modules/wallet/application/request-wallet-transfer.service.js";
import type { WalletRepository } from "../src/modules/wallet/repository/wallet.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";
import {
  GOOD_STATE,
  PROPERTY_ADDRESS,
  RECIPIENT_ADDRESS,
  WALLET_ADDRESS,
  blockHash,
  createTransferWorld,
  rpcFailure,
  serveTransferWorld,
  type TransferWorld,
} from "./support/transfer-chain-world.js";

// The one thing an operator has when POST /wallet/transfers answers 503: the
// server log. The first staging smoke is also where the provider's EIP-1898
// support is found out, so the log has to tell "rejects block hashes" apart
// from "header not found", a rate limit and a timeout, and it must never hold
// the RPC URL or key. This runs the real chain reader over HTTP, the real
// service, router and error handler, and the real pino logger.

const SECRET = "SECRET-API-KEY-123";
const HEAD = blockHash("d5");

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function post(arrange: (world: TransferWorld) => void) {
  const world = createTransferWorld({ head: HEAD, states: { [HEAD]: GOOD_STATE } });
  arrange(world);
  const rpcUrl = `${await serveTransferWorld(world, servers)}/v2/${SECRET}`;
  const chainReader = new ViemWalletChainReader(
    new ChainReader({
      network: "base-sepolia",
      rpcUrl,
      propertyContractAddress: PROPERTY_ADDRESS,
      eurcTokenAddress: `0x${"c".repeat(40)}`,
    }),
  );
  const repository: WalletRepository = {
    registerWallet: vi.fn(),
    findByAccountId: vi.fn().mockResolvedValue({
      walletAddress: WALLET_ADDRESS,
      registrationCommitment: "commitment_01",
      requestedAt: new Date("2026-09-02T10:00:00.000Z"),
      registeredAt: new Date("2026-09-02T10:05:00.000Z"),
    }),
  };
  const lines: string[] = [];
  const logger = createLogger(
    "info",
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString("utf8"));
        done();
      },
    }),
  );
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = { accountId: "acct_01", providerSessionId: "session_01", population: "customer" };
    next();
  };
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.logger = logger;
    next();
  });
  app.use(
    "/v1/investor-profile/wallet",
    createWalletRouter(
      authenticated,
      new RegisterWalletService(repository, { getEligibilitySnapshot: vi.fn() }, PROPERTY_ADDRESS),
      new GetWalletStatusService(repository),
      undefined,
      new RequestWalletTransferService(
        repository,
        { listTokenHoldings: vi.fn().mockResolvedValue([{ pivId: "piv_01", tokenId: "7" }]) },
        chainReader,
      ),
    ),
  );
  app.use(errorHandler);

  const response = await request(app)
    .post("/v1/investor-profile/wallet/transfers")
    .send({ piv_id: "piv_01", to_wallet_address: RECIPIENT_ADDRESS, amount: "3" });
  return { response, log: lines.join("\n"), world };
}

describe("a 503 from POST /wallet/transfers, as the operator sees it", () => {
  it("logs that the provider rejected the block hash, without the URL, the key or the node's words", async () => {
    const { response, log } = await post((world) => {
      world.simulationFailure = () => {
        throw rpcFailure({ code: -32602, message: `invalid argument 1: blockHash at /v2/${SECRET}` });
      };
    });

    expect(response.status).toBe(503);
    expect(log).toContain("request failed");
    expect(log).toContain("ChainStateUnavailableError");
    expect(log).toContain("code -32602");
    expect(log).not.toContain(SECRET);
    expect(log).not.toMatch(/127\.0\.0\.1|https?:\/\//);
    // The client is told nothing of it.
    expect(JSON.stringify(response.body)).not.toMatch(/-32602|ChainStateUnavailable|RpcRequest|viem/);
    expect(response.body.code).toBe("wallet.chain_unavailable");
  });

  it("logs a missing header differently from a rejected block hash", async () => {
    const { response, log } = await post((world) => {
      world.simulationFailure = () => {
        throw rpcFailure({ code: -32000, message: "header not found" });
      };
    });

    expect(response.status).toBe(503);
    expect(log).toContain("code -32000");
    expect(log).not.toContain("code -32602");
    expect(log).not.toContain(SECRET);
  });

  it("answers 200 from the second head when the first was unknown to the backend that served the pinned calls", async () => {
    const unknown = blockHash("e6");
    const { response, log, world } = await post((arranged) => {
      let reads = 0;
      arranged.headResponse = () => ({
        number: "0x3e8",
        hash: reads++ === 0 ? unknown : HEAD,
        transactions: [],
      });
    });

    expect(response.status).toBe(200);
    expect(response.body.data.preflight.block_hash).toBe(HEAD);
    expect(world.calls.filter((call) => call.method === "eth_getBlockByNumber")).toHaveLength(2);
    expect(log).toBe("");
  });
});

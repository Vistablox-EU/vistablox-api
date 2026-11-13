import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  ChainClients,
  ChainReader,
  type ChainSettlementConfig,
} from "../src/infrastructure/blockchain/chain-client.js";
import { ViemWalletChainReader } from "../src/infrastructure/blockchain/chain-wallet-reader.js";
import {
  GOOD_STATE,
  PROPERTY_ADDRESS,
  RECIPIENT_ADDRESS,
  WALLET_ADDRESS,
  blockHash,
  createTransferWorld,
} from "./support/transfer-chain-world.js";

const baseConfig: ChainSettlementConfig = {
  network: "base-sepolia",
  rpcUrl: "https://sepolia.base.org",
  operatorPrivateKey: `0x${"1".repeat(64)}`,
};

describe("ChainClients", () => {
  it("constructs from base chain connectivity alone, with no settlement bundle or wallet registry configured", () => {
    expect(() => new ChainClients(baseConfig)).not.toThrow();
  });

  it("throws a clear error from .property when propertyContractAddress is not configured", () => {
    const chain = new ChainClients(baseConfig);
    expect(() => chain.property).toThrow(
      "VISTABLOX_PROPERTY_CONTRACT_ADDRESS is not configured -- cannot access the property contract.",
    );
  });

  it("throws a clear error from .ipoEscrow when ipoEscrowContractAddress is not configured", () => {
    const chain = new ChainClients(baseConfig);
    expect(() => chain.ipoEscrow).toThrow(
      "VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS is not configured -- cannot access the IPO escrow contract.",
    );
  });

  it("still throws a clear error from .walletRegistry when walletRegistryContractAddress is not configured (unchanged behavior)", () => {
    const chain = new ChainClients(baseConfig);
    expect(() => chain.walletRegistry).toThrow(
      "VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS is not configured -- cannot access the wallet registry contract.",
    );
  });

  it("exposes .walletRegistry once configured, independent of the (still-unconfigured) settlement bundle", () => {
    const chain = new ChainClients({
      ...baseConfig,
      walletRegistryContractAddress: `0x${"e".repeat(40)}`,
    });
    expect(() => chain.walletRegistry).not.toThrow();
    expect(() => chain.property).toThrow();
    expect(() => chain.ipoEscrow).toThrow();
  });

  it("exposes .property and .ipoEscrow once the settlement bundle is configured", () => {
    const chain = new ChainClients({
      ...baseConfig,
      propertyContractAddress: `0x${"a".repeat(40)}`,
      ipoEscrowContractAddress: `0x${"b".repeat(40)}`,
      eurcTokenAddress: `0x${"c".repeat(40)}`,
      pivTreasuryAddress: `0x${"d".repeat(40)}`,
    });
    expect(() => chain.property).not.toThrow();
    expect(() => chain.ipoEscrow).not.toThrow();
  });
});

describe("ChainReader transfer snapshot", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  // A real JSON-RPC-over-HTTP endpoint backed by the in-memory chain model, so
  // the production http transport, config wiring and chain id are exercised.
  async function serve(world: ReturnType<typeof createTransferWorld>): Promise<string> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id: number;
          method: string;
          params: unknown;
        };
        world
          .request({ method: body.method, params: body.params })
          .then((result) => ({ jsonrpc: "2.0", id: body.id, result }))
          .catch((error: { code: number; message: string; data?: unknown }) => ({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: error.code, message: error.message, data: error.data },
          }))
          .then((payload) => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(payload));
          });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("exposes readTransferSnapshot and still has no wallet account or signing client", () => {
    const reader = new ChainReader({
      network: "base-sepolia",
      rpcUrl: "https://sepolia.base.org",
      propertyContractAddress: PROPERTY_ADDRESS,
      eurcTokenAddress: `0x${"c".repeat(40)}`,
    });

    expect(typeof reader.readTransferSnapshot).toBe("function");
    const own = Object.keys(reader);
    expect(own.some((key) => /wallet|account|signer|privateKey/i.test(key))).toBe(false);
    expect(typeof (reader as unknown as Record<string, unknown>).sendTransaction).toBe("undefined");
  });

  it("reads and simulates through the real http transport at one pinned block", async () => {
    const head = blockHash("c3");
    const world = createTransferWorld({ head, states: { [head]: GOOD_STATE } });
    const rpcUrl = await serve(world);
    const reader = new ChainReader({
      network: "base-sepolia",
      rpcUrl,
      propertyContractAddress: PROPERTY_ADDRESS,
      eurcTokenAddress: `0x${"c".repeat(40)}`,
    });

    const snapshot = await new ViemWalletChainReader(reader).readTransferSnapshot({
      from: WALLET_ADDRESS,
      to: RECIPIENT_ADDRESS,
      tokenId: "7",
      amount: "3",
    });

    expect(snapshot).toMatchObject({
      block: { number: 1000n, hash: head },
      senderBalance: 10n,
      recipientAuthorized: true,
      tokenPaused: false,
      simulation: { status: "passed" },
      unsignedTransaction: { chainId: 84532, to: PROPERTY_ADDRESS, value: "0" },
    });
    expect(snapshot.unsignedTransaction.data.startsWith("0xf242432a")).toBe(true);
    const pins = world.calls
      .filter((call) => call.method === "eth_call")
      .map((call) => (call.params as [unknown, unknown])[1]);
    expect(pins).toEqual([
      { blockHash: head, requireCanonical: true },
      { blockHash: head, requireCanonical: true },
    ]);
  });
});

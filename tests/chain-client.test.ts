import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { encodeErrorResult, offchainLookupAbiItem } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import {
  ChainClients,
  ChainReader,
  type ChainSettlementConfig,
} from "../src/infrastructure/blockchain/chain-client.js";
import { ViemWalletChainReader } from "../src/infrastructure/blockchain/chain-wallet-reader.js";
import { assessTransferPreflight } from "../src/modules/wallet/domain/transfer-preflight-policy.js";
import {
  GOOD_STATE,
  PROPERTY_ADDRESS,
  RECIPIENT_ADDRESS,
  WALLET_ADDRESS,
  blockHash,
  createTransferWorld,
  revertData,
  rpcFailure,
  serveTransferWorld,
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

  const serve = (world: ReturnType<typeof createTransferWorld>) => serveTransferWorld(world, servers);

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

  // EIP-3668. Once a transfer lane is open, the property contract bubbles a
  // recipient contract's onERC1155Received revert data verbatim, so the
  // recipient can make the simulated eth_call revert with
  // OffchainLookup(sender = the property contract, urls = [anything], ...).
  // viem's `sender == to` check passes (the revert data names the property
  // contract), so with viem's default ccipRead the API server would send an
  // HTTP request to a URL the recipient chose, then make an unpinned follow-up
  // call: a blind SSRF. Nothing this reader reads or simulates needs an
  // off-chain lookup, so the client must never follow one.
  it("does not follow an OffchainLookup revert from the simulation", async () => {
    const head = blockHash("d4");
    const world = createTransferWorld({ head, states: { [head]: GOOD_STATE } });

    const gatewayRequests: string[] = [];
    const gateway = createServer((request, response) => {
      gatewayRequests.push(`${request.method} ${request.url}`);
      request.resume();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: "0x" }));
    });
    servers.push(gateway);
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/lookup`;

    // The first simulation reverts with OffchainLookup, as a hostile recipient
    // contract could make it. Any later simulation (the follow-up call viem
    // makes when it does follow the lookup) reverts TransferLaneClosed.
    let simulations = 0;
    world.simulationFailure = () => {
      simulations += 1;
      if (simulations === 1) {
        throw rpcFailure({
          code: 3,
          message: "execution reverted",
          data: encodeErrorResult({
            abi: [offchainLookupAbiItem],
            errorName: "OffchainLookup",
            args: [PROPERTY_ADDRESS, [gatewayUrl], "0xdeadbeef", "0x12345678", "0x"],
          }),
        });
      }
      throw rpcFailure({
        code: 3,
        message: "execution reverted",
        data: revertData("TransferLaneClosed"),
      });
    };

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

    // No request to the URL the revert data named.
    expect(gatewayRequests).toEqual([]);
    // Exactly the multicall and the one simulation, both pinned: no follow-up
    // (and unpinned) eth_call.
    const pins = world.calls
      .filter((call) => call.method === "eth_call")
      .map((call) => (call.params as [unknown, unknown])[1]);
    expect(pins).toEqual([
      { blockHash: head, requireCanonical: true },
      { blockHash: head, requireCanonical: true },
    ]);
    // The unrecognised revert is an ordinary "would revert" answer.
    expect(snapshot.simulation).toEqual({ status: "reverted", revert: {} });
    expect(assessTransferPreflight({ amount: 3n, state: snapshot })).toBe("transfer_would_revert");
  });
});

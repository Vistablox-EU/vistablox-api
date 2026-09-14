import { describe, expect, it } from "vitest";

import { ChainClients, type ChainSettlementConfig } from "../src/infrastructure/blockchain/chain-client.js";

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

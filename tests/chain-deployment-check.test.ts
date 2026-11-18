import { describe, expect, it } from "vitest";

import {
  ChainConfigurationError,
  verifyChainDeployment,
  type ChainDeploymentRpc,
} from "../src/infrastructure/blockchain/chain-deployment-check.js";

const PROPERTY = "0x1111111111111111111111111111111111111111";
const EURC = "0x2222222222222222222222222222222222222222";

function rpc(chainId: number, codeByAddress: Record<string, string | undefined>): ChainDeploymentRpc {
  return {
    getChainId: async () => chainId,
    getCode: async ({ address }) => codeByAddress[address],
  };
}

const contracts = [
  { setting: "VISTABLOX_PROPERTY_CONTRACT_ADDRESS", address: PROPERTY },
  { setting: "EURC_TOKEN_ADDRESS", address: EURC },
] as const;

describe("verifyChainDeployment", () => {
  it("accepts the right chain with code at every address", async () => {
    await expect(
      verifyChainDeployment({
        network: "base-sepolia",
        rpc: rpc(84532, { [PROPERTY]: "0x6080", [EURC]: "0x6080" }),
        contracts,
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts a chain with no contracts configured", async () => {
    await expect(verifyChainDeployment({ network: "base", rpc: rpc(8453, {}), contracts: [] })).resolves.toBeUndefined();
  });

  it("rejects an endpoint on the wrong chain, naming both chain IDs", async () => {
    const attempt = verifyChainDeployment({
      network: "base",
      rpc: rpc(84532, { [PROPERTY]: "0x6080", [EURC]: "0x6080" }),
      contracts,
    });
    await expect(attempt).rejects.toThrow(ChainConfigurationError);
    await expect(attempt).rejects.toThrow(/reports chain ID 84532.*CHAIN_NETWORK=base expects 8453/);
  });

  it("does not look at contract code when the chain is wrong", async () => {
    let codeReads = 0;
    const counting: ChainDeploymentRpc = {
      getChainId: async () => 1,
      getCode: async () => {
        codeReads += 1;
        return "0x6080";
      },
    };
    await expect(verifyChainDeployment({ network: "base", rpc: counting, contracts })).rejects.toThrow(ChainConfigurationError);
    expect(codeReads).toBe(0);
  });

  it.each([["0x"], [undefined]])("rejects an address with empty code (%s), naming the setting", async (code) => {
    const attempt = verifyChainDeployment({
      network: "base-sepolia",
      rpc: rpc(84532, { [PROPERTY]: "0x6080", [EURC]: code }),
      contracts,
    });
    await expect(attempt).rejects.toThrow(ChainConfigurationError);
    await expect(attempt).rejects.toThrow(/EURC_TOKEN_ADDRESS .* has no contract code/);
  });

  it("rethrows an unreachable endpoint unchanged", async () => {
    const down = new Error("fetch failed");
    await expect(
      verifyChainDeployment({
        network: "base",
        rpc: { getChainId: async () => Promise.reject(down), getCode: async () => "0x6080" },
        contracts,
      }),
    ).rejects.toBe(down);
  });
});

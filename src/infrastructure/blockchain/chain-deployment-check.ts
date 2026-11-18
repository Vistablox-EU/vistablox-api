import type { Address } from "viem";

const EXPECTED_CHAIN_ID = { base: 8453, "base-sepolia": 84532 } as const;

export interface DeployedContract {
  // The environment variable the address came from, so the error names what to fix.
  setting: string;
  address: Address;
}

export interface ChainDeploymentRpc {
  getChainId(): Promise<number>;
  getCode(args: { address: Address }): Promise<string | undefined>;
}

/** The configured chain or contract addresses do not match what the RPC endpoint serves. */
export class ChainConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChainConfigurationError";
  }
}

/**
 * Checks, before a process starts serving, that CHAIN_RPC_URL is on the chain
 * CHAIN_NETWORK names and that every configured contract address holds
 * bytecode there. Rejects with a ChainConfigurationError that names the
 * setting to fix. An unreachable RPC endpoint is rethrown as-is: that is an
 * availability problem, not a misconfiguration.
 *
 * Existence of code is checked, not its hash: pinning runtime code hashes would
 * need a compiled-artifact source in CI that this repository does not have yet.
 */
export async function verifyChainDeployment(input: {
  network: "base" | "base-sepolia";
  rpc: ChainDeploymentRpc;
  contracts: readonly DeployedContract[];
}): Promise<void> {
  const expected = EXPECTED_CHAIN_ID[input.network];
  const reported = await input.rpc.getChainId();
  if (reported !== expected) {
    throw new ChainConfigurationError(
      `CHAIN_RPC_URL reports chain ID ${reported}, but CHAIN_NETWORK=${input.network} expects ${expected}. Point CHAIN_RPC_URL at a ${input.network} endpoint or correct CHAIN_NETWORK.`,
    );
  }
  for (const contract of input.contracts) {
    const code = await input.rpc.getCode({ address: contract.address });
    if (code === undefined || code === "0x") {
      throw new ChainConfigurationError(
        `${contract.setting} (${contract.address}) has no contract code on ${input.network}. Check the address and that it was deployed to this network.`,
      );
    }
  }
}

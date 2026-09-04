import { createPublicClient, createWalletClient, http, getContract, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

import vistaBloxPropertyAbi from "./abis/VistaBloxProperty.abi.json" with { type: "json" };
import vistaBloxIpoEscrowAbi from "./abis/VistaBloxIpoEscrow.abi.json" with { type: "json" };

export interface ChainSettlementConfig {
  network: "base" | "base-sepolia";
  rpcUrl: string;
  operatorPrivateKey: Hex;
  propertyContractAddress: Address;
  ipoEscrowContractAddress: Address;
  eurcTokenAddress: Address;
  pivTreasuryAddress: Address;
}

/**
 * Thin bundle over the two deployed VistaBlox contracts (AD-163's shared
 * ERC-1155, AD-256's IPO escrow), typed against their compiled ABIs
 * (contracts:export-abi). One operator account signs every write this
 * backend makes -- it must hold MINTER_ROLE/BURNER_ROLE/PAUSER_ROLE/
 * TRANSFER_AGENT_ROLE/DOCUMENT_ROLE on VistaBloxProperty and
 * CAMPAIGN_MANAGER_ROLE on VistaBloxIpoEscrow (see contracts/scripts/deploy.js
 * for the dev/testnet role-grant convenience this mirrors; production should
 * assign these more deliberately, per AD-165).
 */
export class ChainClients {
  public readonly config: ChainSettlementConfig;

  public readonly publicClient;
  public readonly walletClient;

  public constructor(config: ChainSettlementConfig) {
    this.config = config;
    const chain = config.network === "base" ? base : baseSepolia;
    const transport = http(config.rpcUrl);
    const account = privateKeyToAccount(config.operatorPrivateKey);

    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ chain, transport, account });
  }

  public get operatorAddress(): Address {
    return this.walletClient.account.address;
  }

  public get property() {
    return getContract({
      address: this.config.propertyContractAddress,
      abi: vistaBloxPropertyAbi,
      client: { public: this.publicClient, wallet: this.walletClient },
    });
  }

  public get ipoEscrow() {
    return getContract({
      address: this.config.ipoEscrowContractAddress,
      abi: vistaBloxIpoEscrowAbi,
      client: { public: this.publicClient, wallet: this.walletClient },
    });
  }
}

export function createChainClients(config: ChainSettlementConfig): ChainClients {
  return new ChainClients(config);
}

import { createPublicClient, createWalletClient, erc20Abi, http, getContract, type Address, type Hex, type Transport } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

import vistaBloxPropertyAbi from "./abis/VistaBloxProperty.abi.json" with { type: "json" };
import vistaBloxIpoEscrowAbi from "./abis/VistaBloxIpoEscrow.abi.json" with { type: "json" };

type OperatorChain = typeof base | typeof baseSepolia;

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

  public readonly publicClient: ReturnType<typeof createPublicClient<Transport, OperatorChain>>;
  public readonly walletClient: ReturnType<
    typeof createWalletClient<Transport, OperatorChain, PrivateKeyAccount>
  >;

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

export interface ChainReaderConfig {
  network: "base" | "base-sepolia";
  rpcUrl: string;
  propertyContractAddress: Address;
  eurcTokenAddress: Address;
}

/**
 * Read-only counterpart to ChainClients, for processes (the API server) that
 * have no business holding the operator private key at all. Investor
 * wallets are self-custodied (AD-240): this backend can read balances an
 * investor's wallet already holds, but must never be able to sign or
 * broadcast a transaction on their behalf. Everything here resolves to an
 * `eth_call` against publicClient -- there is no wallet account anywhere in
 * this class, so that's a structural guarantee, not just a convention.
 */
export class ChainReader {
  public readonly config: ChainReaderConfig;
  private readonly publicClient: ReturnType<typeof createPublicClient<Transport, OperatorChain>>;

  public constructor(config: ChainReaderConfig) {
    this.config = config;
    const chain = config.network === "base" ? base : baseSepolia;
    this.publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
  }

  public get property() {
    return getContract({
      address: this.config.propertyContractAddress,
      abi: vistaBloxPropertyAbi,
      client: this.publicClient,
    });
  }

  public get eurc() {
    return getContract({
      address: this.config.eurcTokenAddress,
      abi: erc20Abi,
      client: this.publicClient,
    });
  }
}

export function createChainReader(config: ChainReaderConfig): ChainReader {
  return new ChainReader(config);
}

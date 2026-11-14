import { createPublicClient, http, type Address, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

import {
  WalletRegistrationVerificationError,
  type VerifiedWalletRegistration,
  type WalletRegistrationChainVerifier,
} from "../../modules/wallet/application/reconcile-wallet-registration.service.js";
import { WalletRegistryChainReader, type WalletRegistryRpc } from "./wallet-registry-chain-reader.js";

// A manual reconcile accepts a transaction only once it is this many blocks
// deep, the same depth the watcher waits before it reads a block
// (WALLET_REGISTRY_CONFIRMATION_DEPTH). Kept as its own constant so this file
// does not import the settlement module; a test asserts the two are equal.
export const WALLET_REGISTRATION_RECONCILE_CONFIRMATIONS = 3n;

/**
 * The chain side of the staff reconcile: finds the WalletRegistered event of a
 * wallet and commitment in a transaction (WalletRegistryChainReader), checks
 * that its block is deep enough, and reports anything else as a typed
 * WalletRegistrationVerificationError for the application service to turn into
 * a response.
 */
export class ViemWalletRegistrationVerifier implements WalletRegistrationChainVerifier {
  private readonly rpc: WalletRegistryRpc;
  private readonly reader: WalletRegistryChainReader;

  public constructor(
    network: "base" | "base-sepolia",
    rpcUrl: string,
    registryAddress: Address,
    rpc?: WalletRegistryRpc,
  ) {
    this.rpc = rpc ?? createPublicClient({ chain: network === "base" ? base : baseSepolia, transport: http(rpcUrl) });
    this.reader = new WalletRegistryChainReader(this.rpc, registryAddress);
  }

  public async verify(input: {
    txHash: string;
    walletAddress: string;
    commitment: string;
  }): Promise<VerifiedWalletRegistration> {
    const lookup = await this.guarded(() =>
      this.reader.findRegistrationEvent({
        transactionHash: input.txHash as Hex,
        walletAddress: input.walletAddress,
        commitment: input.commitment,
      }),
    );
    if (lookup.kind !== "found") throw new WalletRegistrationVerificationError(lookup.kind);

    const head = await this.guarded(() => this.rpc.getBlockNumber());
    if (head < lookup.evidence.blockNumber + WALLET_REGISTRATION_RECONCILE_CONFIRMATIONS) {
      throw new WalletRegistrationVerificationError("not_sufficiently_confirmed");
    }
    return { ...lookup.evidence, registeredAt: lookup.chainTimestamp };
  }

  // Anything the node call throws is an availability problem, not an answer.
  private async guarded<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw new WalletRegistrationVerificationError("chain_unavailable", { cause: error });
    }
  }
}

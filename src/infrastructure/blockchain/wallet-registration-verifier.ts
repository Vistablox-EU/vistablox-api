import { createPublicClient, decodeEventLog, http, type Address, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import abi from "./abis/VistaBloxWalletRegistry.abi.json" with { type: "json" };
import type { WalletRegistrationChainVerifier } from "../../modules/wallet/application/reconcile-wallet-registration.service.js";

export class ViemWalletRegistrationVerifier implements WalletRegistrationChainVerifier {
  private readonly client;
  private readonly address: Address;
  public constructor(network: "base" | "base-sepolia", rpcUrl: string, registryAddress: Address) {
    this.client = createPublicClient({ chain: network === "base" ? base : baseSepolia, transport: http(rpcUrl) });
    this.address = registryAddress;
  }
  public async verify(input: { txHash: string; walletAddress: string; commitment: string }) {
    const receipt = await this.client.getTransactionReceipt({ hash: input.txHash as Hex });
    if (receipt.status !== "success") throw new Error("Wallet registration transaction reverted.");
    const head = await this.client.getBlockNumber();
    if (head < receipt.blockNumber + 3n) throw new Error("Wallet registration transaction is not sufficiently confirmed yet.");
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.address.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
        if (decoded.eventName !== "WalletRegistered") continue;
        const args = decoded.args as unknown as { wallet: string; commitment: string; timestamp: bigint };
        if (args.wallet.toLowerCase() !== input.walletAddress.toLowerCase() || args.commitment.toLowerCase() !== input.commitment.toLowerCase()) continue;
        return { blockNumber: receipt.blockNumber, registeredAt: new Date(Number(args.timestamp) * 1000) };
      } catch { /* unrelated log */ }
    }
    throw new Error("No matching WalletRegistered event found in transaction.");
  }
}

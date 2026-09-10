import type { Address } from "viem";

import type { WalletChainReader } from "../../modules/wallet/application/get-wallet-balance.service.js";
import type { ChainReader } from "./chain-client.js";

export class ViemWalletChainReader implements WalletChainReader {
  public constructor(private readonly chain: ChainReader) {}

  public async getCapitalBalance(walletAddress: string): Promise<bigint> {
    return this.chain.eurc.read.balanceOf([walletAddress as Address]);
  }

  public async getTokenBalances(walletAddress: string, tokenIds: string[]): Promise<bigint[]> {
    const addresses = tokenIds.map(() => walletAddress as Address);
    const ids = tokenIds.map((tokenId) => BigInt(tokenId));
    return this.chain.property.read.balanceOfBatch!([addresses, ids]) as Promise<bigint[]>;
  }
}

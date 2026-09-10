import type { Address } from "viem";

import type { WalletChainReader } from "../../modules/wallet/application/get-wallet-balance.service.js";
import type {
  UnsignedTransferTransaction,
  WalletTransferChainReader,
} from "../../modules/wallet/application/request-wallet-transfer.service.js";
import type { ChainReader } from "./chain-client.js";

export class ViemWalletChainReader implements WalletChainReader, WalletTransferChainReader {
  public constructor(private readonly chain: ChainReader) {}

  public async getCapitalBalance(walletAddress: string): Promise<bigint> {
    return this.chain.eurc.read.balanceOf([walletAddress as Address]);
  }

  public async getTokenBalances(walletAddress: string, tokenIds: string[]): Promise<bigint[]> {
    const addresses = tokenIds.map(() => walletAddress as Address);
    const ids = tokenIds.map((tokenId) => BigInt(tokenId));
    return this.chain.property.read.balanceOfBatch!([addresses, ids]) as Promise<bigint[]>;
  }

  public async getTokenBalance(walletAddress: string, tokenId: string): Promise<bigint> {
    return this.chain.property.read.balanceOf!([
      walletAddress as Address,
      BigInt(tokenId),
    ]) as Promise<bigint>;
  }

  public async isHolderAuthorized(walletAddress: string, tokenId: string): Promise<boolean> {
    return this.chain.property.read.isHolderAuthorized!([
      walletAddress as Address,
      BigInt(tokenId),
    ]) as Promise<boolean>;
  }

  public async isTokenPaused(tokenId: string): Promise<boolean> {
    return this.chain.property.read.isTokenPaused!([BigInt(tokenId)]) as Promise<boolean>;
  }

  public buildTransferRequest(input: {
    from: string;
    to: string;
    tokenId: string;
    amount: string;
  }): UnsignedTransferTransaction {
    return {
      chainId: this.chain.chainId,
      to: this.chain.config.propertyContractAddress,
      data: this.chain.encodeTransferCalldata({
        from: input.from as Address,
        to: input.to as Address,
        tokenId: BigInt(input.tokenId),
        amount: BigInt(input.amount),
      }),
      value: "0",
    };
  }
}

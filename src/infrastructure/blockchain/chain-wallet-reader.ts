import { BaseError, ContractFunctionRevertedError, type Address } from "viem";

import type { WalletChainReader } from "../../modules/wallet/application/get-wallet-balance.service.js";
import type { WalletTransferChainReader } from "../../modules/wallet/application/request-wallet-transfer.service.js";
import type { ChainReader } from "./chain-client.js";
import { ChainStateUnavailableError } from "../../shared/errors/chain-state-unavailable-error.js";
import { describe, type TransferSnapshot } from "./transfer-snapshot.js";

// A balance read is one or two eth_calls. Bounded so a stalled provider
// cannot hold the request open for viem's retry rounds (3 x 10 s each).
export const BALANCE_READ_BUDGET_MS = 10_000;

// A failure to get an answer from the chain becomes ChainStateUnavailableError,
// whose message carries no URL, key or node text (see describe). A contract
// revert is an answer from the chain, not an outage, and is rethrown as it
// is so it stays a non-retryable failure.
async function readWithinBudget<T>(read: () => Promise<T>, budgetMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ChainStateUnavailableError("chain balance read timed out")),
      budgetMs,
    );
  });
  const attempt = read();
  // If the deadline wins, the abandoned read may still reject later.
  attempt.catch(() => undefined);
  try {
    return await Promise.race([attempt, deadline]);
  } catch (error) {
    if (error instanceof ChainStateUnavailableError) {
      throw error;
    }
    if (
      error instanceof BaseError &&
      error.walk((candidate) => candidate instanceof ContractFunctionRevertedError) !== null
    ) {
      throw error;
    }
    throw new ChainStateUnavailableError(describe(error));
  } finally {
    clearTimeout(timer);
  }
}

export class ViemWalletChainReader implements WalletChainReader, WalletTransferChainReader {
  public constructor(
    private readonly chain: ChainReader,
    private readonly balanceBudgetMs: number = BALANCE_READ_BUDGET_MS,
  ) {}

  public async getCapitalBalance(walletAddress: string): Promise<bigint> {
    return readWithinBudget(
      () => this.chain.eurc.read.balanceOf([walletAddress as Address]),
      this.balanceBudgetMs,
    );
  }

  public async getTokenBalances(walletAddress: string, tokenIds: string[]): Promise<bigint[]> {
    const addresses = tokenIds.map(() => walletAddress as Address);
    const ids = tokenIds.map((tokenId) => BigInt(tokenId));
    return readWithinBudget(
      () => this.chain.property.read.balanceOfBatch!([addresses, ids]) as Promise<bigint[]>,
      this.balanceBudgetMs,
    );
  }

  public readTransferSnapshot(input: {
    from: string;
    to: string;
    tokenId: string;
    amount: string;
  }): Promise<TransferSnapshot> {
    return this.chain.readTransferSnapshot(input);
  }
}

import { AppError } from "../../../shared/errors/app-error.js";
import { fromEurcMicros } from "../../../shared/domain/currency.js";
import type { PivTokenHoldingsReader } from "../../settlement/repository/settlement.repository.js";
import type { WalletRepository } from "../repository/wallet.repository.js";

// Read-only: this service only ever calls out to WalletChainReader's
// eth_call-backed methods, never anything that signs or broadcasts. The
// investor's wallet is self-custodied (AD-240) -- this backend can show what
// it already holds, nothing more.
export interface WalletChainReader {
  getCapitalBalance(walletAddress: string): Promise<bigint>;
  getTokenBalances(walletAddress: string, tokenIds: string[]): Promise<bigint[]>;
}

export class GetWalletBalanceService {
  public constructor(
    private readonly walletRepository: WalletRepository,
    private readonly pivTokenHoldingsReader: PivTokenHoldingsReader,
    private readonly chainReader: WalletChainReader,
  ) {}

  public async execute(accountId: string) {
    const wallet = await this.walletRepository.findByAccountId(accountId);
    if (wallet === null) {
      throw new AppError({
        code: "wallet.not_registered",
        title: "Wallet not registered",
        status: 404,
        detail: "This account has no registered wallet address.",
      });
    }

    const holdings = await this.pivTokenHoldingsReader.listTokenHoldings(accountId);
    const [capitalMicros, tokenBalances] = await Promise.all([
      this.chainReader.getCapitalBalance(wallet.walletAddress),
      holdings.length === 0
        ? Promise.resolve([])
        : this.chainReader.getTokenBalances(
            wallet.walletAddress,
            holdings.map((holding) => holding.tokenId),
          ),
    ]);

    return {
      data: {
        wallet_address: wallet.walletAddress,
        capital_eurc: fromEurcMicros(capitalMicros),
        tokens: holdings.map((holding, index) => ({
          piv_id: holding.pivId,
          token_id: holding.tokenId,
          balance: tokenBalances[index]!.toString(),
        })),
      },
    };
  }
}

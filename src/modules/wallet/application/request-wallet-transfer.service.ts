import { AppError } from "../../../shared/errors/app-error.js";
import type { PivTokenHoldingsReader } from "../../settlement/repository/settlement.repository.js";
import type { WalletRepository } from "../repository/wallet.repository.js";

export interface UnsignedTransferTransaction {
  chainId: number;
  to: string;
  data: string;
  value: string;
}

// Prepare-only: every method here either reads chain state or (for
// buildTransferRequest) pure-encodes calldata -- nothing signs or
// broadcasts anything. The returned transaction is unsigned; it exists only
// to be handed to the investor's own wallet/device to sign and submit
// itself. See WalletChainReader's doc comment (get-wallet-balance.service.ts)
// and AD-240 for why that boundary matters.
export interface WalletTransferChainReader {
  getTokenBalance(walletAddress: string, tokenId: string): Promise<bigint>;
  isHolderAuthorized(walletAddress: string, tokenId: string): Promise<boolean>;
  isTokenPaused(tokenId: string): Promise<boolean>;
  buildTransferRequest(input: {
    from: string;
    to: string;
    tokenId: string;
    amount: string;
  }): UnsignedTransferTransaction;
}

export class RequestWalletTransferService {
  public constructor(
    private readonly walletRepository: WalletRepository,
    private readonly pivTokenHoldingsReader: PivTokenHoldingsReader,
    private readonly chainReader: WalletTransferChainReader,
  ) {}

  public async execute(input: {
    accountId: string;
    pivId: string;
    toWalletAddress: string;
    amount: string;
  }) {
    const wallet = await this.walletRepository.findByAccountId(input.accountId);
    if (wallet === null) {
      throw new AppError({
        code: "wallet.not_registered",
        title: "Wallet not registered",
        status: 404,
        detail: "This account has no registered wallet address.",
      });
    }

    const holdings = await this.pivTokenHoldingsReader.listTokenHoldings(input.accountId);
    const holding = holdings.find((candidate) => candidate.pivId === input.pivId);
    if (holding === undefined) {
      throw new AppError({
        code: "wallet.piv_not_held",
        title: "No holding for this PIV",
        status: 404,
        detail: "This account does not hold a minted token position for the given PIV.",
      });
    }

    const [balance, recipientAuthorized, tokenPaused] = await Promise.all([
      this.chainReader.getTokenBalance(wallet.walletAddress, holding.tokenId),
      this.chainReader.isHolderAuthorized(input.toWalletAddress, holding.tokenId),
      this.chainReader.isTokenPaused(holding.tokenId),
    ]);

    if (tokenPaused) {
      throw new AppError({
        code: "wallet.token_paused",
        title: "Token transfers paused",
        status: 422,
        detail: "This PIV's token is currently paused and cannot be transferred.",
      });
    }
    if (!recipientAuthorized) {
      throw new AppError({
        code: "wallet.recipient_not_authorized",
        title: "Recipient not authorized",
        status: 422,
        detail: "The recipient wallet is not authorized to hold this PIV's token.",
      });
    }

    const amount = BigInt(input.amount);
    if (amount > balance) {
      throw new AppError({
        code: "wallet.insufficient_balance",
        title: "Insufficient balance",
        status: 422,
        detail: "The requested amount exceeds the wallet's on-chain token balance.",
      });
    }

    const unsignedTransaction = this.chainReader.buildTransferRequest({
      from: wallet.walletAddress,
      to: input.toWalletAddress,
      tokenId: holding.tokenId,
      amount: input.amount,
    });

    return {
      data: {
        piv_id: holding.pivId,
        token_id: holding.tokenId,
        amount: input.amount,
        from_wallet_address: wallet.walletAddress,
        to_wallet_address: input.toWalletAddress,
        unsigned_transaction: {
          chain_id: unsignedTransaction.chainId,
          to: unsignedTransaction.to,
          data: unsignedTransaction.data,
          value: unsignedTransaction.value,
        },
      },
    };
  }
}

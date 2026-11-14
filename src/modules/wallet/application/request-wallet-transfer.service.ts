import { AppError } from "../../../shared/errors/app-error.js";
import { ChainStateUnavailableError } from "../../../shared/errors/chain-state-unavailable-error.js";
import type { PivTokenHoldingsReader } from "../../settlement/repository/settlement.repository.js";
import {
  assessTransferPreflight,
  type TransferChainState,
  type TransferPreflightFailure,
} from "../domain/transfer-preflight-policy.js";
import type { WalletRepository } from "../repository/wallet.repository.js";

export interface UnsignedTransferTransaction {
  chainId: number;
  to: string;
  data: string;
  value: string;
}

// A uint256 cannot carry more than this; viem would throw while encoding.
const MAX_UINT256 = 2n ** 256n - 1n;

// Prepare-only: the one method here reads chain state at a single block,
// simulates the exact transfer at that block, and pure-encodes the calldata
// that was simulated -- nothing signs or broadcasts anything. The returned
// transaction is unsigned; it exists only to be handed to the investor's own
// wallet/device to sign and submit itself. Reading and simulating at one
// block is what keeps the preview and the prepared transfer in agreement
// (AD-267). A failure to read the chain throws ChainStateUnavailableError;
// a contract rejection is part of the snapshot, not an exception. See
// WalletChainReader's doc comment (get-wallet-balance.service.ts) and AD-240
// for why the no-signing boundary matters.
export interface WalletTransferChainReader {
  readTransferSnapshot(input: {
    from: string;
    to: string;
    tokenId: string;
    amount: string;
  }): Promise<TransferChainState & { unsignedTransaction: UnsignedTransferTransaction }>;
}

const FAILURE_ERRORS: Record<
  TransferPreflightFailure,
  { code: string; title: string; detail: string }
> = {
  transfer_lane_closed: {
    code: "wallet.transfer_lane_closed",
    title: "Transfers not open",
    detail: "Transfers of this token between wallets are not open yet. Nothing was prepared.",
  },
  token_paused: {
    code: "wallet.token_paused",
    title: "Token transfers paused",
    detail: "This PIV's token is currently paused and cannot be transferred.",
  },
  recipient_not_authorized: {
    code: "wallet.recipient_not_authorized",
    title: "Recipient not authorized",
    detail: "The recipient wallet is not authorized to hold this PIV's token.",
  },
  insufficient_balance: {
    code: "wallet.insufficient_balance",
    title: "Insufficient balance",
    detail: "The requested amount exceeds the wallet's on-chain token balance.",
  },
  recipient_cannot_receive: {
    code: "wallet.recipient_cannot_receive",
    title: "Recipient cannot receive",
    detail: "The recipient address cannot receive this token.",
  },
  transfer_would_revert: {
    code: "wallet.transfer_would_revert",
    title: "Transfer would be rejected",
    detail: "The token contract would reject this transfer. Nothing was prepared.",
  },
};

function failureError(failure: TransferPreflightFailure): AppError {
  return new AppError({ ...FAILURE_ERRORS[failure], status: 422 });
}

// One code, title and status for "no wallet row" and "pending claim": the
// client keys on the code, and only the detail (log and support text, not
// contractual) says which of the two it was.
function walletNotRegisteredError(detail: string): AppError {
  return new AppError({
    code: "wallet.not_registered",
    title: "Wallet not registered",
    status: 404,
    detail,
  });
}

// A transfer is prepared only for a confirmed wallet registration
// (registered_at set). A pending claim is an address the customer typed and
// proves nothing about who controls it, and several accounts may hold a
// pending claim on one address, so it is treated as no wallet. The first check
// made, before the holdings or the chain are read.
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
    // Read once, and this same row supplies the address below. A confirmed row
    // cannot be given another address, so there is nothing to re-check later.
    const wallet = await this.walletRepository.findByAccountId(input.accountId);
    if (wallet === null) {
      throw walletNotRegisteredError("This account has no registered wallet address.");
    }
    if (wallet.registeredAt === null) {
      throw walletNotRegisteredError(
        "This account's wallet registration is not confirmed yet. A transfer can be prepared once it is.",
      );
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

    const amount = BigInt(input.amount);
    if (amount > MAX_UINT256) {
      // No balance can reach this, and encoding it would throw. Answered
      // without touching the chain, as it was before the snapshot existed.
      throw failureError("insufficient_balance");
    }

    let snapshot: Awaited<ReturnType<WalletTransferChainReader["readTransferSnapshot"]>>;
    try {
      snapshot = await this.chainReader.readTransferSnapshot({
        from: wallet.walletAddress,
        to: input.toWalletAddress,
        tokenId: holding.tokenId,
        amount: input.amount,
      });
    } catch (error) {
      if (error instanceof ChainStateUnavailableError) {
        // The cause is for the server log only (the error handler never puts
        // it in the response): it says which kind of failure this was, for
        // example a provider that rejects block hashes versus a missing
        // header, and by construction carries no URL or key.
        throw new AppError({
          code: "wallet.chain_unavailable",
          title: "Chain state unavailable",
          status: 503,
          detail: "The on-chain state could not be read. Try again shortly.",
          cause: error,
        });
      }
      throw error;
    }

    const failure = assessTransferPreflight({ amount, state: snapshot });
    if (failure !== null) {
      throw failureError(failure);
    }

    // Every field below comes from this one snapshot. assessTransferPreflight
    // returned null, so the literals are what the snapshot said at that block.
    return {
      data: {
        piv_id: holding.pivId,
        token_id: holding.tokenId,
        amount: input.amount,
        from_wallet_address: wallet.walletAddress,
        to_wallet_address: input.toWalletAddress,
        unsigned_transaction: {
          chain_id: snapshot.unsignedTransaction.chainId,
          to: snapshot.unsignedTransaction.to,
          data: snapshot.unsignedTransaction.data,
          value: snapshot.unsignedTransaction.value,
        },
        preflight: {
          block_number: snapshot.block.number.toString(),
          block_hash: snapshot.block.hash,
          sender_balance: snapshot.senderBalance.toString(),
          recipient_authorized: true as const,
          token_paused: false as const,
          simulation: "passed" as const,
        },
      },
    };
  }
}

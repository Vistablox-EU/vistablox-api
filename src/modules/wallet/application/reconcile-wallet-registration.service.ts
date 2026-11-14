import { AppError } from "../../../shared/errors/app-error.js";
import {
  normalizeChainHash,
  type WalletRegistrationEvidence,
} from "../../../shared/domain/wallet-registration-evidence.js";
import type {
  ReconcileWalletRegistrationOutcome,
  RegisteredWallet,
  WalletRepository,
} from "../repository/wallet.repository.js";

/** Why the chain could not confirm a registration transaction. */
export type WalletRegistrationVerificationFailure =
  | "transaction_not_found"
  | "transaction_reverted"
  | "not_sufficiently_confirmed"
  | "event_not_found"
  | "chain_unavailable";

/**
 * Thrown by a WalletRegistrationChainVerifier. The infrastructure side only
 * says what went wrong; the status, code and wording the client sees are this
 * service's.
 */
export class WalletRegistrationVerificationError extends Error {
  public constructor(
    public readonly reason: WalletRegistrationVerificationFailure,
    options?: { cause?: unknown },
  ) {
    super(`Wallet registration could not be verified: ${reason}`, options);
    this.name = "WalletRegistrationVerificationError";
  }
}

/** The event the chain shows for a registration transaction. */
export interface VerifiedWalletRegistration {
  transactionHash: string;
  blockHash: string;
  blockNumber: bigint;
  logIndex: number;
  // The event's own timestamp argument.
  registeredAt: Date;
}

export interface WalletRegistrationChainVerifier {
  verify(input: { txHash: string; walletAddress: string; commitment: string }): Promise<VerifiedWalletRegistration>;
}

/** Staff recovery path for a registration event missed by the watcher, or a recorded one that went wrong. */
export class ReconcileWalletRegistrationService {
  public constructor(
    private readonly repository: WalletRepository,
    private readonly verifier: WalletRegistrationChainVerifier,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: { accountId: string; txHash: string; actorAccountId: string }) {
    const txHash = normalizeChainHash(input.txHash);
    const wallet = await this.repository.findByAccountId(input.accountId);
    if (wallet === null) throw accountNotFound();
    const reconcile = this.repository.reconcileWalletRegistration;
    if (reconcile === undefined) {
      throw new AppError({
        code: "wallet.reconciliation_unavailable",
        title: "Wallet reconciliation unavailable",
        status: 503,
        detail: "Wallet registration reconciliation is not available on this deployment.",
      });
    }

    // Nothing to do, and no chain call: the row already holds a complete,
    // unflagged record of this very transaction. A row with partial or no
    // evidence, or a flag, goes to the chain.
    if (
      wallet.registeredAt !== null &&
      wallet.registrationEvidenceFlaggedAt == null &&
      wallet.registrationTxHash?.toLowerCase() === txHash &&
      wallet.registrationBlockNumber != null &&
      wallet.registrationBlockHash != null &&
      wallet.registrationLogIndex != null
    ) {
      return respond(input.accountId, wallet, wallet.registeredAt, "unchanged", {
        transactionHash: wallet.registrationTxHash,
        blockHash: wallet.registrationBlockHash,
        blockNumber: wallet.registrationBlockNumber,
        logIndex: wallet.registrationLogIndex,
      });
    }

    let evidence: VerifiedWalletRegistration;
    try {
      evidence = await this.verifier.verify({
        txHash,
        walletAddress: wallet.walletAddress.toLowerCase(),
        commitment: wallet.registrationCommitment.toLowerCase(),
      });
    } catch (error) {
      if (error instanceof WalletRegistrationVerificationError) throw verificationFailure(error);
      throw error;
    }

    const result = await reconcile.call(this.repository, {
      accountId: input.accountId,
      actorAccountId: input.actorAccountId,
      evidence: {
        transactionHash: normalizeChainHash(evidence.transactionHash),
        blockHash: normalizeChainHash(evidence.blockHash),
        blockNumber: evidence.blockNumber,
        logIndex: evidence.logIndex,
      },
      registeredAt: evidence.registeredAt,
      changedAt: this.clock(),
    });

    if (result.kind === "not_found") throw accountNotFound();
    if (result.kind === "conflict") {
      throw result.reason === "event_taken"
        ? new AppError({
            code: "wallet.registration_event_already_used",
            title: "Registration event already used",
            status: 409,
            detail: "This on-chain event already backs the registration of another account. Nothing was changed.",
          })
        : new AppError({
            code: "wallet.registration_evidence_conflict",
            title: "Registration already confirmed by another event",
            status: 409,
            detail:
              "This registration was confirmed by a different on-chain event. The recorded evidence was not changed.",
          });
    }
    // Every reconciled outcome leaves the row holding exactly the verified
    // event, and registered_at as the row has it (written only for a pending row).
    if (result.wallet.registeredAt === null) throw new Error("A reconciled wallet registration is not registered.");
    return respond(input.accountId, result.wallet, result.wallet.registeredAt, result.outcome, {
      transactionHash: normalizeChainHash(evidence.transactionHash),
      blockHash: normalizeChainHash(evidence.blockHash),
      blockNumber: evidence.blockNumber,
      logIndex: evidence.logIndex,
    });
  }
}

function respond(
  accountId: string,
  wallet: RegisteredWallet,
  registeredAt: Date,
  outcome: ReconcileWalletRegistrationOutcome,
  evidence: WalletRegistrationEvidence,
) {
  return {
    data: {
      account_id: accountId,
      wallet_address: wallet.walletAddress,
      status: "registered" as const,
      registration_tx_hash: evidence.transactionHash,
      registration_block_number: evidence.blockNumber.toString(),
      registration_block_hash: evidence.blockHash,
      registration_log_index: evidence.logIndex,
      outcome,
      requested_at: wallet.requestedAt.toISOString(),
      registered_at: registeredAt.toISOString(),
    },
  };
}

function accountNotFound(): AppError {
  return new AppError({
    code: "wallet.account_not_found",
    title: "Wallet account not found",
    status: 404,
    detail: "This account has no wallet registration.",
  });
}

function verificationFailure(error: WalletRegistrationVerificationError): AppError {
  switch (error.reason) {
    case "transaction_not_found":
      return new AppError({
        code: "wallet.registration_transaction_not_found",
        title: "Transaction not found",
        status: 422,
        detail: "No mined transaction with this hash was found on the configured chain.",
      });
    case "transaction_reverted":
      return new AppError({
        code: "wallet.registration_transaction_reverted",
        title: "Transaction reverted",
        status: 422,
        detail: "This transaction reverted on the chain, so it registered nothing.",
      });
    case "event_not_found":
      // Deliberately does not echo the commitment: AD-240 treats it as non-public.
      return new AppError({
        code: "wallet.registration_event_not_found",
        title: "Registration event not found",
        status: 422,
        detail: "This transaction has no WalletRegistered event for this account's wallet.",
      });
    case "not_sufficiently_confirmed":
      return new AppError({
        code: "wallet.registration_transaction_unconfirmed",
        title: "Transaction not confirmed yet",
        status: 409,
        detail: "This transaction has fewer than the required confirmations. Retry in a minute.",
      });
    case "chain_unavailable":
      return new AppError({
        code: "wallet.chain_unavailable",
        title: "Chain unavailable",
        status: 503,
        detail: "The chain could not be read right now. Retry shortly.",
        cause: error.cause ?? error,
      });
  }
}

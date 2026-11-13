import { AppError } from "../../../shared/errors/app-error.js";
import { WalletAddressConflictError, WalletRegistrationChangedError, type WalletRepository } from "../repository/wallet.repository.js";

export interface WalletRegistrationChainVerifier {
  verify(input: { txHash: string; walletAddress: string; commitment: string }): Promise<{ blockNumber: bigint; registeredAt: Date }>;
}

/** Staff recovery path for a registration event missed by the watcher. */
export class ReconcileWalletRegistrationService {
  public constructor(private readonly repository: WalletRepository, private readonly verifier: WalletRegistrationChainVerifier) {}

  public async execute(input: { accountId: string; txHash: string; actorAccountId: string }) {
    const wallet = await this.repository.findByAccountId(input.accountId);
    if (wallet === null) throw new AppError({ code: "wallet.account_not_found", title: "Wallet account not found", status: 404, detail: "This account has no wallet registration." });
    if (wallet.registeredAt !== null && wallet.registrationTxHash === input.txHash) return { data: { account_id: input.accountId, wallet_address: wallet.walletAddress, status: "registered" as const, registration_tx_hash: input.txHash, registration_block_number: wallet.registrationBlockNumber?.toString() ?? "0", requested_at: wallet.requestedAt.toISOString(), registered_at: wallet.registeredAt.toISOString() } };
    if (this.repository.reconcileWalletRegistration === undefined) throw new Error("Wallet reconciliation repository is unavailable.");
    const evidence = await this.verifier.verify({ txHash: input.txHash, walletAddress: wallet.walletAddress, commitment: wallet.registrationCommitment });
    // The evidence was verified against this exact address and commitment. The
    // repository confirms only if the account's row still holds both, so a
    // claim the customer replaced in the meantime is never confirmed on the
    // old claim's evidence.
    let reconciled;
    try {
      reconciled = await this.repository.reconcileWalletRegistration({
        ...input,
        expectedWalletAddress: wallet.walletAddress,
        expectedRegistrationCommitment: wallet.registrationCommitment,
        blockNumber: evidence.blockNumber,
        registeredAt: evidence.registeredAt,
      });
    } catch (error) {
      if (error instanceof WalletRegistrationChangedError) {
        throw new AppError({ code: "wallet.registration_changed", title: "Wallet registration changed", status: 409, detail: "The account's wallet registration changed after the transaction was checked. Read the registration again and retry." });
      }
      if (error instanceof WalletAddressConflictError) {
        throw new AppError({ code: "wallet.address_already_claimed", title: "Wallet address unavailable", status: 409, detail: "That wallet address is already confirmed for a different account." });
      }
      throw error;
    }
    return { data: { account_id: input.accountId, wallet_address: reconciled.walletAddress, status: "registered" as const, registration_tx_hash: input.txHash, registration_block_number: evidence.blockNumber.toString(), requested_at: reconciled.requestedAt.toISOString(), registered_at: evidence.registeredAt.toISOString() } };
  }
}

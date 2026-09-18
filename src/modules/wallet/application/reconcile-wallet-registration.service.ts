import { AppError } from "../../../shared/errors/app-error.js";
import type { WalletRepository } from "../repository/wallet.repository.js";

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
    const reconciled = await this.repository.reconcileWalletRegistration({ ...input, blockNumber: evidence.blockNumber, registeredAt: evidence.registeredAt });
    return { data: { account_id: input.accountId, wallet_address: reconciled.walletAddress, status: "registered" as const, registration_tx_hash: input.txHash, registration_block_number: evidence.blockNumber.toString(), requested_at: reconciled.requestedAt.toISOString(), registered_at: evidence.registeredAt.toISOString() } };
  }
}

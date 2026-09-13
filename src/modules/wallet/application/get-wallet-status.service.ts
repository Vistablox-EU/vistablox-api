import { AppError } from "../../../shared/errors/app-error.js";
import type { WalletRepository } from "../repository/wallet.repository.js";

// Deliberately independent of GetWalletBalanceService: the address and
// registration status come straight off the wallet_registrations row this
// backend already owns, with no chain read involved, so this stays available
// even in an environment with no CHAIN_* configured at all -- exactly the
// case today. GetWalletBalanceService's on-chain capital/token reads are the
// only part of "my wallet" that genuinely needs live chain access, so they
// stay behind their own, separately gated GET /balance route instead of
// blocking this one.
export class GetWalletStatusService {
  public constructor(private readonly repository: WalletRepository) {}

  public async execute(accountId: string) {
    const wallet = await this.repository.findByAccountId(accountId);
    if (wallet === null) {
      throw new AppError({
        code: "wallet.not_registered",
        title: "Wallet not registered",
        status: 404,
        detail: "This account has no registered wallet address.",
      });
    }
    return {
      data: {
        wallet_address: wallet.walletAddress,
        status: wallet.registeredAt === null ? ("pending" as const) : ("registered" as const),
        requested_at: wallet.requestedAt.toISOString(),
        registered_at: wallet.registeredAt?.toISOString() ?? null,
      },
    };
  }
}

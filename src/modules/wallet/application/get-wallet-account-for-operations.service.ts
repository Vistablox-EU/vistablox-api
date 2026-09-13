import { AppError } from "../../../shared/errors/app-error.js";
import type { WalletRepository } from "../repository/wallet.repository.js";

// Staff-only counterpart to GetWalletStatusService (the customer's own GET
// /v1/investor-profile/wallet): same underlying row, read via the staff-
// supplied account_id path param rather than the authenticated session's
// own account, for support/ops visibility into a stuck or disputed
// registration. This route is staff-only and WebAuthn-gated (see
// wallet-operations.router.ts), the same trust boundary
// kyc-operations.router.ts already relies on for an arbitrary
// staff-supplied account_id.
export class GetWalletAccountForOperationsService {
  public constructor(private readonly repository: WalletRepository) {}

  public async execute(accountId: string) {
    const wallet = await this.repository.findByAccountId(accountId);
    // A missing record reports 404 rather than a synthesized "not
    // registered" response, since an arbitrary staff-supplied account_id
    // might just be a typo -- same rationale as
    // GetKycAccountForOperationsService.
    if (wallet === null) throw walletAccountNotFoundError();
    return {
      data: {
        account_id: accountId,
        wallet_address: wallet.walletAddress,
        registration_commitment: wallet.registrationCommitment,
        status: wallet.registeredAt === null ? ("pending" as const) : ("registered" as const),
        requested_at: wallet.requestedAt.toISOString(),
        registered_at: wallet.registeredAt?.toISOString() ?? null,
      },
    };
  }
}

function walletAccountNotFoundError(): AppError {
  return new AppError({
    code: "wallet.account_not_found",
    title: "Wallet account not found",
    status: 404,
    detail: "This account has no registered wallet address.",
  });
}

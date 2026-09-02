import { randomBytes } from "node:crypto";

import { AppError } from "../../../shared/errors/app-error.js";
import {
  WalletAddressConflictError,
  type InvestorProfileRepository,
  type RegisteredWallet,
} from "../repository/investor-profile.repository.js";

export class RegisterWalletService {
  public constructor(
    private readonly repository: InvestorProfileRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly generateCommitment: () => string = () =>
      randomBytes(32).toString("base64url"),
  ) {}

  public async execute(input: { accountId: string; walletAddress: string }) {
    const profile = await this.repository.get(input.accountId);
    if (profile === null) {
      throw new AppError({
        code: "investor_profile.not_found",
        title: "Investor profile not found",
        status: 404,
        detail: "The authenticated investor profile does not exist.",
      });
    }
    if (profile.accountStatus !== "active") {
      throw new AppError({
        code: "account.restricted",
        title: "Account restricted",
        status: 403,
        detail: "Wallet registration is unavailable while the account is restricted.",
      });
    }
    const now = this.clock();
    // AD-241: wallet provisioning happens right at KYC approval, before any
    // reservation — gate on KYC eligibility specifically, not the broader
    // investment_eligible composite (which also requires linked login
    // methods, a separate concern from being cleared to hold a wallet).
    const kycEligible =
      profile.kyc?.eligibilityState === "eligible" &&
      profile.kyc.renewalDueAt !== null &&
      profile.kyc.renewalDueAt > now;
    if (!kycEligible) {
      throw new AppError({
        code: "identity.kyc_required",
        title: "KYC required",
        status: 403,
        detail: "Wallet registration requires current KYC eligibility.",
      });
    }

    try {
      const wallet = await this.repository.registerWallet({
        accountId: input.accountId,
        walletAddress: input.walletAddress,
        registrationCommitment: this.generateCommitment(),
        requestedAt: now,
      });
      return { data: toWalletPayload(wallet) };
    } catch (error) {
      if (error instanceof WalletAddressConflictError) {
        throw walletConflictError(error.reason);
      }
      throw error;
    }
  }
}

function walletConflictError(reason: "address_mismatch" | "address_claimed"): AppError {
  if (reason === "address_mismatch") {
    return new AppError({
      code: "wallet.registration_address_mismatch",
      title: "Wallet already registered",
      status: 409,
      detail:
        "This account already has a registered wallet address, and it does not match the one submitted. Changing a registered wallet address is not supported here.",
    });
  }
  return new AppError({
    code: "wallet.address_already_claimed",
    title: "Wallet address unavailable",
    status: 409,
    detail: "That wallet address is already registered to a different account.",
  });
}

function toWalletPayload(wallet: RegisteredWallet) {
  return {
    wallet_address: wallet.walletAddress,
    registration_commitment: wallet.registrationCommitment,
    status: wallet.registeredAt === null ? ("pending" as const) : ("registered" as const),
    requested_at: wallet.requestedAt.toISOString(),
    registered_at: wallet.registeredAt?.toISOString() ?? null,
  };
}

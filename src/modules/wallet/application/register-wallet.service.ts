import { randomBytes } from "node:crypto";

import { AppError } from "../../../shared/errors/app-error.js";
import { freshAuthenticationRequiredError } from "../../../shared/errors/fresh-authentication-required-error.js";
import type { KycEligibilityReader } from "../../identity/repository/kyc-eligibility-reader.js";
import {
  WalletAddressConflictError,
  WalletReplacementFreshAuthenticationRequiredError,
  type RegisteredWallet,
  type WalletRepository,
} from "../repository/wallet.repository.js";

export class RegisterWalletService {
  public constructor(
    private readonly repository: WalletRepository,
    private readonly kycEligibilityReader: KycEligibilityReader,
    // undefined until VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS is set --
    // independently configurable from the rest of the chain-settlement
    // bundle, see environment.ts.
    private readonly registryContractAddress: string | undefined,
    private readonly clock: () => Date = () => new Date(),
    // A 0x-prefixed 32-byte hex string: must be usable directly as the
    // VistaBloxWalletRegistry.register(bytes32) argument the mobile app
    // signs and broadcasts (ON_CHAIN_SETTLEMENT.md's Address Registration
    // flow, step 5-6), not an arbitrary opaque string format.
    private readonly generateCommitment: () => string = () =>
      `0x${randomBytes(32).toString("hex")}`,
  ) {}

  // freshAuthentication is whether the caller's session confirmed who is
  // holding the device recently enough. The router computes it server-side
  // from the authenticated session and passes it through unchanged; it is
  // required, with no default, so a forgotten argument cannot read as fresh.
  // It only matters when this call would replace the account's own pending
  // claim with a different address, which only the repository can know under
  // its row lock.
  public async execute(input: { accountId: string; walletAddress: string; freshAuthentication: boolean }) {
    if (this.registryContractAddress === undefined) {
      throw new AppError({
        code: "wallet.on_chain_registration_unavailable",
        title: "Wallet registration unavailable",
        status: 503,
        detail: "On-chain wallet registration is not yet configured for this environment.",
      });
    }
    const now = this.clock();
    const kyc = await this.kycEligibilityReader.getEligibilitySnapshot(input.accountId);
    // AD-241: wallet provisioning happens right at KYC approval, before any
    // reservation — gate on KYC eligibility specifically, not the broader
    // investment_eligible composite (which also requires linked login
    // methods, a separate concern from being cleared to hold a wallet).
    const kycEligible =
      kyc?.eligibilityState === "eligible" &&
      kyc.renewalDueAt !== null &&
      kyc.renewalDueAt > now;
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
        freshAuthentication: input.freshAuthentication,
      });
      return { data: toWalletPayload(wallet, this.registryContractAddress) };
    } catch (error) {
      if (error instanceof WalletAddressConflictError) {
        throw walletConflictError(error.reason);
      }
      // Same envelope as requireFreshAuthentication on the other /v1 routes:
      // the client signs in again on the device and repeats the same request.
      if (error instanceof WalletReplacementFreshAuthenticationRequiredError) {
        throw freshAuthenticationRequiredError();
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

function toWalletPayload(wallet: RegisteredWallet, registryContractAddress: string | undefined) {
  return {
    wallet_address: wallet.walletAddress,
    registration_commitment: wallet.registrationCommitment,
    // Guaranteed non-null here: execute() already rejects with a 503
    // before reaching this point when the registry isn't configured.
    registry_contract_address: registryContractAddress as string,
    status: wallet.registeredAt === null ? ("pending" as const) : ("registered" as const),
    requested_at: wallet.requestedAt.toISOString(),
    registered_at: wallet.registeredAt?.toISOString() ?? null,
  };
}

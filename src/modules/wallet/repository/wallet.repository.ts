export interface RegisteredWallet {
  walletAddress: string;
  registrationCommitment: string;
  requestedAt: Date;
  registeredAt: Date | null;
  registrationTxHash?: string | null;
  registrationBlockNumber?: bigint | null;
}

// address_mismatch: the account's own registration is CONFIRMED on a different
// address. address_claimed: the address is CONFIRMED for another account. A
// pending claim never produces either: it is account-scoped, replaceable by
// its own account, and does not block anyone else.
export class WalletAddressConflictError extends Error {
  public constructor(public readonly reason: "address_mismatch" | "address_claimed") {
    super(`Wallet address conflict: ${reason}`);
  }
}

// The registration a caller verified (its address and commitment) is no longer
// the account's registration: the customer replaced the pending claim between
// the read and the write, so the evidence no longer applies to it.
export class WalletRegistrationChangedError extends Error {
  public constructor() {
    super("The wallet registration changed after it was read.");
  }
}

export interface WalletRepository {
  registerWallet(input: {
    accountId: string;
    walletAddress: string;
    registrationCommitment: string;
    requestedAt: Date;
  }): Promise<RegisteredWallet>;
  findByAccountId(accountId: string): Promise<RegisteredWallet | null>;
  // Compare-and-set on the registration the caller verified: expectedWalletAddress
  // and expectedRegistrationCommitment must still be what the account's row
  // holds, otherwise nothing is written and WalletRegistrationChangedError is
  // thrown. WalletAddressConflictError("address_claimed") when another account
  // already holds the address confirmed.
  reconcileWalletRegistration?(input: {
    accountId: string;
    expectedWalletAddress: string;
    expectedRegistrationCommitment: string;
    txHash: string;
    blockNumber: bigint;
    registeredAt: Date;
    actorAccountId: string;
  }): Promise<RegisteredWallet>;
}

// Read-only boundary port for wallet registration status, for modules
// outside wallet (profile, so far) that need to show whether an account has
// a wallet on file without depending on WalletRepository's write surface.
// Backed by the single shared PrismaWalletRepository instance each process
// constructs -- a live read, not a local copy. Same rationale as
// KycEligibilityReader in identity/repository/kyc-eligibility-reader.ts.
export interface WalletStatusSnapshot {
  requestedAt: Date;
  registeredAt: Date | null;
}

export interface WalletStatusReader {
  getStatus(accountId: string): Promise<WalletStatusSnapshot | null>;
}

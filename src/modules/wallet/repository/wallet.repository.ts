export interface RegisteredWallet {
  walletAddress: string;
  registrationCommitment: string;
  requestedAt: Date;
  registeredAt: Date | null;
}

export class WalletAddressConflictError extends Error {
  public constructor(public readonly reason: "address_mismatch" | "address_claimed") {
    super(`Wallet address conflict: ${reason}`);
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

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

// The account's own claim is still pending, the submitted address is a
// different one, and the caller's session has not confirmed recently who is
// holding it (founder decision of 2026-11-14 on conflict C-010, question 2:
// replacing a pending claim needs fresh authentication). Nothing was written.
// It carries no payload on purpose: not the address, not the account, not the
// commitment, so nothing about the claim can leak through it.
export class WalletReplacementFreshAuthenticationRequiredError extends Error {
  public constructor() {
    super("Replacing a pending wallet claim requires fresh authentication.");
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
    // Computed server-side by the caller from the authenticated session, never
    // from anything the client sends, and required so that omitting it cannot
    // default to "fresh". It is consulted only when this call would replace
    // the account's own pending claim with a DIFFERENT address, and only
    // there, under the row lock, because only there is the row known:
    // WalletReplacementFreshAuthenticationRequiredError when it is false.
    // First registration, a replay of the same address (in any hex case, with
    // surrounding whitespace) and every confirmed-registration outcome never
    // look at it.
    freshAuthentication: boolean;
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

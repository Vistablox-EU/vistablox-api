import type {
  WalletRegistrationEvidence,
  WalletRegistrationEvidenceFlag,
} from "../../../shared/domain/wallet-registration-evidence.js";

export interface RegisteredWallet {
  walletAddress: string;
  registrationCommitment: string;
  requestedAt: Date;
  registeredAt: Date | null;
  registrationTxHash?: string | null;
  registrationBlockNumber?: bigint | null;
  // The rest of the confirming event's identity and the state of its re-check
  // (see settlement.wallet_registrations). Optional so a caller that only needs
  // the registration itself does not have to carry them.
  registrationBlockHash?: string | null;
  registrationLogIndex?: number | null;
  registrationEvidenceVerifiedAt?: Date | null;
  registrationEvidenceFlaggedAt?: Date | null;
  registrationEvidenceFlag?: WalletRegistrationEvidenceFlag | null;
}

export interface ReconcileWalletRegistrationInput {
  accountId: string;
  actorAccountId: string;
  // The registration the caller verified the evidence against, exactly as the
  // row held it when it was read. The reconcile is a compare-and-set on both:
  // if the account replaced its pending claim since, nothing is written and
  // WalletRegistrationChangedError is thrown, so the new, unproven address is
  // never confirmed on the old address's evidence.
  expectedWalletAddress: string;
  expectedRegistrationCommitment: string;
  // The event as the chain verifier read it, hashes lower case.
  evidence: WalletRegistrationEvidence;
  // The event's own timestamp; only written when the row is still pending.
  registeredAt: Date;
  // Stamped on the audit row (the chain time stays in its changes).
  changedAt: Date;
}

/**
 * What a reconcile did to the registration row:
 *  - confirmed: the row was pending; registered_at and the evidence were written.
 *  - evidence_recorded: the row was registered without evidence (or with a
 *    transaction hash and block number only); the evidence was filled in.
 *  - evidence_replaced: the row was flagged or its transaction was mined again;
 *    the evidence was replaced and the flag cleared.
 *  - unchanged: the row already holds exactly this event.
 * registered_at is only ever written for a pending row.
 */
export type ReconcileWalletRegistrationOutcome =
  | "confirmed"
  | "evidence_recorded"
  | "evidence_replaced"
  | "unchanged";

export type ReconcileWalletRegistrationResult =
  | { kind: "reconciled"; outcome: ReconcileWalletRegistrationOutcome; wallet: RegisteredWallet }
  // different_event: the registration is already confirmed by another on-chain
  // event and is not flagged. event_taken: the event backs another account's row.
  | { kind: "conflict"; reason: "different_event" | "event_taken" }
  | { kind: "not_found" };

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
  // Compare-and-set on the registration the caller verified (see
  // ReconcileWalletRegistrationInput): WalletRegistrationChangedError when the
  // row no longer holds expectedWalletAddress and expectedRegistrationCommitment,
  // WalletAddressConflictError("address_claimed") when another account already
  // holds the address confirmed. Both leave the row untouched.
  reconcileWalletRegistration?(input: ReconcileWalletRegistrationInput): Promise<ReconcileWalletRegistrationResult>;
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

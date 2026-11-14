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

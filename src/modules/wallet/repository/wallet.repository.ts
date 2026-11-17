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
  // Set when the expiry job retired the claim while it was still pending
  // (#177). Only findByAccountId with includeExpired returns such a row.
  expiredAt?: Date | null;
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

// The account's own claim is still pending, or expired and not yet renewed,
// the submitted address is a different one, and the caller's session has not
// confirmed recently who is holding it (founder decision of 2026-11-14 on
// conflict C-010, question 2: replacing a pending claim needs fresh
// authentication; AD-287, decided 2026-11-17, applies the same rule to
// registering again after the claim expired). Nothing was written.
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
    // the account's own pending claim, or re-register over its expired one,
    // with a DIFFERENT address, and only there, under the row lock, because
    // only there is the row known:
    // WalletReplacementFreshAuthenticationRequiredError when it is false.
    // First registration, a replay of the same address (in any hex case, with
    // surrounding whitespace; after expiry too, though that renews the
    // commitment) and every confirmed-registration outcome never look at it.
    freshAuthentication: boolean;
  }): Promise<RegisteredWallet>;
  // An expired claim (expiredAt set) is no wallet at all, so it reads as null
  // unless the caller asks for it with includeExpired (the staff view does).
  findByAccountId(accountId: string, options?: { includeExpired?: boolean }): Promise<RegisteredWallet | null>;
  // Compare-and-set on the registration the caller verified (see
  // ReconcileWalletRegistrationInput): WalletRegistrationChangedError when the
  // row no longer holds expectedWalletAddress and expectedRegistrationCommitment,
  // WalletAddressConflictError("address_claimed") when another account already
  // holds the address confirmed. Both leave the row untouched.
  reconcileWalletRegistration?(input: ReconcileWalletRegistrationInput): Promise<ReconcileWalletRegistrationResult>;
}

export interface ExpirePendingWalletRegistrationsResult {
  // Claims still pending past the cutoff when the run started.
  checked: number;
  // Claims this run marked expired. Lower than checked when another
  // transaction (a confirmation, a replacement, a concurrent run) held the
  // row, or when the backlog is larger than one run's batch; the next run
  // picks up the rest.
  expired: number;
}

// The expiry job's port (#177): marks the claims still pending whose
// requested_at is at or before `cutoff` (now minus the lifetime, so a claim
// requested exactly one lifetime ago has expired) as expired at `now`, oldest
// first, at most `batchSize` of them, one audit row
// settlement.wallet_registration_expired each. A confirmed row is never
// touched, and no row is ever deleted.
export interface WalletRegistrationExpiryRepository {
  expirePendingWalletRegistrations(input: {
    cutoff: Date;
    now: Date;
    batchSize: number;
  }): Promise<ExpirePendingWalletRegistrationsResult>;
}

// What the expiry sweep asks before it expires anything (AD-287, decided
// 2026-11-17): may a claim that has not been confirmed be taken for abandoned?
// Not while the registry watcher is stale or its cursor lags, because a claim
// whose registration event the watcher has not read yet is not abandoned. The
// answer comes from the settlement module's health policy, wired in worker.ts
// (a module cannot import another's application layer, so the port is
// declared here and met structurally there).
export interface WalletRegistryWatcherAssessment {
  mayExpire: boolean;
  // Why not, when it is not: the health policy's alert event names
  // (wallet_registry.watcher_stalled, ...). Empty when mayExpire is true.
  reasons: readonly string[];
}

export interface WalletRegistryWatcherGate {
  // Rejects when the health snapshot cannot be read; the sweep treats that as
  // "may not expire" (fail closed toward not expiring).
  assess(now: Date): Promise<WalletRegistryWatcherAssessment>;
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

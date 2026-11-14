import type {
  WalletRegistrationEvidence,
  WalletRegistrationEvidenceFlag,
} from "../../../shared/domain/wallet-registration-evidence.js";

export interface PivPendingEscrowResolution {
  pivId: string;
  tokenId: string;
}

export interface RecordEscrowMintedPositionInput {
  // The intent this position records the outcome of (see EscrowMintIntent).
  // The position row carries it under a unique constraint, so recording the
  // same mint twice can never produce a second position.
  escrowMintIntentId: string;
  pivId: string;
  accountId: string;
  walletAddress: string;
  unitCount: string;
  costBasisEur: string;
  activatedAt: Date;
  tokenContractAddress: string;
  tokenId: string;
  chainTxHash: string;
}

// sending: a mint transaction may be in flight but no hash is recorded yet.
// mint_sent: the transaction hash is recorded; no position yet.
// recorded: the position and its mint event exist.
export type EscrowMintIntentStatus = "sending" | "mint_sent" | "recorded";

/**
 * The durable record of one contributor's escrow mint (see the
 * escrow_mint_intents model). Written before the mint transaction is sent so
 * that a crash at any later point leaves something for the next run to
 * reconcile against the chain, instead of nothing.
 */
export interface EscrowMintIntent {
  id: string;
  pivId: string;
  accountId: string;
  walletAddress: string;
  tokenContractAddress: string;
  tokenId: string;
  mintAmount: bigint;
  status: EscrowMintIntentStatus;
  mintTxHash: string | null;
  attempt: number;
  attemptedAt: Date;
  searchFromBlock: bigint | null;
}

export interface CreateEscrowMintIntentInput {
  pivId: string;
  accountId: string;
  walletAddress: string;
  tokenContractAddress: string;
  tokenId: string;
  mintAmount: bigint;
  attemptedAt: Date;
  searchFromBlock: bigint | null;
}

/**
 * A wallet_registrations row as the registration watcher sees it, in any
 * state: pending (registeredAt null), registered without evidence (confirmed
 * before evidence was kept), or registered with the identity of the event that
 * confirmed it.
 */
export interface WalletRegistrationRecord {
  accountId: string;
  walletAddress: string;
  registeredAt: Date | null;
  transactionHash: string | null;
  blockNumber: bigint | null;
  blockHash: string | null;
  logIndex: number | null;
  evidenceFlag: WalletRegistrationEvidenceFlag | null;
}

/**
 * The identity a compare-and-set write expects the row to hold (null parts for
 * a row with no or partial evidence). The write only applies while the row
 * still holds exactly this, so two runs cannot overwrite each other's change.
 */
export interface WalletRegistrationEvidenceKey {
  transactionHash: string | null;
  blockHash: string | null;
  logIndex: number | null;
}

export type WalletRegistrationConfirmation = "confirmed" | "already_registered" | "event_taken";

export type WalletRegistrationEvidenceReplacement = "replaced" | "stale" | "event_taken";

/** A registration whose recorded block still has to be compared with the chain. */
export interface WalletRegistrationRecheckCandidate {
  accountId: string;
  walletAddress: string;
  registrationCommitment: string;
  evidence: WalletRegistrationEvidence;
}

export interface WalletRegistrationAddressMismatchInput {
  accountId: string;
  commitment: string;
  storedWalletAddress: string;
  onChainSender: string;
  detectedAt: Date;
}

/**
 * The settlement-side read/write surface AD-256's escrow finalize-and-mint
 * flow needs: which PIVs have a resolvable but not-yet-actioned escrow
 * campaign, resolving an on-chain contributor address back to a
 * KYC-verified account (AD-240's existing wallet_registrations attribution
 * mechanism -- not a new one), and durably recording a position once its
 * mint transaction has actually confirmed on-chain. Also carries AD-241's
 * registration-confirmation surface: matching a WalletRegistered event back
 * to the pending row that requested it, and a block-number watermark so the
 * event watcher never has to rescan from genesis.
 */
export interface SettlementRepository {
  findPivsWithPassedIpoDeadline(now: Date): Promise<PivPendingEscrowResolution[]>;
  resolveAccountIdForWallet(walletAddress: string): Promise<string | null>;
  hasPosition(pivId: string, accountId: string): Promise<boolean>;
  findEscrowMintIntent(pivId: string, accountId: string): Promise<EscrowMintIntent | null>;
  // Writes the intent in `sending` unless one already exists for this
  // (piv, account), in which case nothing is written and the existing row is
  // returned with created=false. The unique key is what makes two overlapping
  // runs unable to both claim the same mint.
  createEscrowMintIntent(
    input: CreateEscrowMintIntentInput,
  ): Promise<{ intent: EscrowMintIntent; created: boolean }>;
  // Compare-and-set start of another send attempt on an intent that is still
  // at the attempt the caller read: back to `sending`, hash cleared, attempt
  // incremented. False means another run got there first.
  restartEscrowMintAttempt(input: {
    intentId: string;
    expectedAttempt: number;
    attemptedAt: Date;
  }): Promise<boolean>;
  // Records the hash of the mint transaction on the attempt that sent it
  // (`sending` -> `mint_sent`). Idempotent for the same hash; throws if the
  // intent is on another attempt or already holds a different hash.
  recordEscrowMintSent(input: { intentId: string; attempt: number; txHash: string }): Promise<void>;
  // Records the confirmed mint: flips the intent to `recorded` and writes the
  // position and its mint event in one transaction. Replaying it for an
  // intent that is already recorded returns the existing position.
  recordEscrowMintedPosition(input: RecordEscrowMintedPositionInput): Promise<{ positionId: string }>;
  // The row a WalletRegistered commitment belongs to, whatever its state:
  // classifying a replayed or reorganized event needs the registered rows
  // too, not only the pending ones.
  findWalletRegistrationByCommitment(commitment: string): Promise<WalletRegistrationRecord | null>;
  countPendingWalletRegistrationsBefore(cutoff: Date): Promise<number>;
  // Confirms a pending row and records the event that confirmed it in ONE
  // statement, so a row is never registered without its evidence or the other
  // way round. "already_registered": the row was not pending any more, nothing
  // was written. "event_taken": another row already holds this (transaction
  // hash, log index); nothing was written.
  confirmWalletRegistration(input: {
    accountId: string;
    registeredAt: Date;
    evidence: WalletRegistrationEvidence;
  }): Promise<WalletRegistrationConfirmation>;
  // Replaces the recorded evidence of a registered row (compare-and-set on
  // `expected`), clears verification and flag, and writes the audit row in the
  // same transaction. registered_at is never changed.
  replaceWalletRegistrationEvidence(input: {
    accountId: string;
    expected: WalletRegistrationEvidenceKey;
    next: WalletRegistrationEvidence;
    reason: "recorded" | "refreshed";
    changedAt: Date;
  }): Promise<WalletRegistrationEvidenceReplacement>;
  // Marks the recorded block final (compare-and-set on `expected`, only while
  // neither verified nor flagged). False when nothing matched.
  markWalletRegistrationEvidenceVerified(input: {
    accountId: string;
    expected: WalletRegistrationEvidenceKey;
    verifiedAt: Date;
  }): Promise<boolean>;
  // Flags the recorded event as no longer on the chain (compare-and-set on
  // `expected`, only while not flagged) and writes the audit row in the same
  // transaction. registered_at is never changed. False when nothing matched.
  flagWalletRegistrationEvidence(input: {
    accountId: string;
    expected: WalletRegistrationEvidenceKey;
    flag: WalletRegistrationEvidenceFlag;
    flaggedAt: Date;
  }): Promise<boolean>;
  // Registered rows with a recorded block that is neither verified nor
  // flagged, oldest block first.
  listWalletRegistrationsForEvidenceRecheck(limit: number): Promise<WalletRegistrationRecheckCandidate[]>;
  getLastProcessedWalletRegistryBlock(): Promise<bigint | null>;
  setLastProcessedWalletRegistryBlock(block: bigint): Promise<void>;
  // A durable, queryable record of a possible spoofed-registration attempt
  // (on-chain sender != the address this account actually has on file) --
  // ConfirmWalletRegistrationsService's own log warning scrolls away; this
  // survives in audit_log for staff/ops to actually find later.
  recordWalletRegistrationAddressMismatch(input: WalletRegistrationAddressMismatchInput): Promise<void>;
}

export interface PivTokenHolding {
  pivId: string;
  tokenId: string;
}

// Read-only boundary port for the set of on-chain-minted PIVs an account
// holds a position in, for modules outside settlement (wallet, so far) that
// need to know which ERC-1155 token ids to check a wallet's balance for
// without depending on this module's write surface. Backed by the single
// shared PrismaSettlementRepository instance each process constructs -- a
// live read, not a local copy. Same rationale as KycEligibilityReader in
// identity/repository/kyc-eligibility-reader.ts.
export interface PivTokenHoldingsReader {
  listTokenHoldings(accountId: string): Promise<PivTokenHolding[]>;
}

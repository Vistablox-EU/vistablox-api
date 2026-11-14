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

export interface PendingWalletRegistration {
  accountId: string;
  walletAddress: string;
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
  findPendingWalletRegistrationByCommitment(commitment: string): Promise<PendingWalletRegistration | null>;
  countPendingWalletRegistrationsBefore(cutoff: Date): Promise<number>;
  confirmWalletRegistration(accountId: string, registeredAt: Date): Promise<void>;
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

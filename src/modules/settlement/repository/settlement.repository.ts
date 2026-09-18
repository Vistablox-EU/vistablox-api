export interface PivPendingEscrowResolution {
  pivId: string;
  tokenId: string;
}

export interface RecordEscrowMintedPositionInput {
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

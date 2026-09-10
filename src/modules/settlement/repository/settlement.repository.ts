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

/**
 * The settlement-side read/write surface AD-256's escrow finalize-and-mint
 * flow needs: which PIVs have a resolvable but not-yet-actioned escrow
 * campaign, resolving an on-chain contributor address back to a
 * KYC-verified account (AD-240's existing wallet_registrations attribution
 * mechanism -- not a new one), and durably recording a position once its
 * mint transaction has actually confirmed on-chain.
 */
export interface SettlementRepository {
  findPivsWithPassedIpoDeadline(now: Date): Promise<PivPendingEscrowResolution[]>;
  resolveAccountIdForWallet(walletAddress: string): Promise<string | null>;
  hasPosition(pivId: string, accountId: string): Promise<boolean>;
  recordEscrowMintedPosition(input: RecordEscrowMintedPositionInput): Promise<{ positionId: string }>;
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

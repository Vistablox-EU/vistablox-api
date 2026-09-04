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

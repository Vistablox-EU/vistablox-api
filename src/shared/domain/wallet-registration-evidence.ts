/**
 * The identity of the WalletRegistered event that confirmed a wallet
 * registration, as recorded on settlement.wallet_registrations.
 *
 * The event is identified by (transactionHash, logIndex), not by the
 * transaction hash alone: VistaBloxWalletRegistry keeps no state and takes any
 * caller, so one transaction (a bundler relaying several registrations,
 * AD-271) can carry several WalletRegistered logs. The block hash is not part
 * of the identity because it changes when the block is reorganized; it is what
 * the re-check compares with the chain.
 *
 * Hashes are stored lower case (0x plus 64 hex digits), the same convention as
 * wallet addresses.
 */
export interface WalletRegistrationEvidence {
  transactionHash: string;
  blockHash: string;
  blockNumber: bigint;
  logIndex: number;
}

/**
 * Why a recorded event was flagged. registered_at is never reverted because of
 * a flag; it tells staff the recorded event is no longer on the chain.
 */
export type WalletRegistrationEvidenceFlag =
  | "transaction_missing"
  | "transaction_reverted"
  | "event_missing";

export const WALLET_REGISTRATION_EVIDENCE_FLAGS: readonly WalletRegistrationEvidenceFlag[] = [
  "transaction_missing",
  "transaction_reverted",
  "event_missing",
];

/** What the row says about its confirming event, for staff views. */
export type WalletRegistrationEvidenceStatus = "none" | "partial" | "recorded" | "verified" | "flagged";

const CHAIN_HASH_PATTERN = /^0x[0-9a-f]{64}$/;

/** The one stored spelling of a transaction or block hash. */
export function normalizeChainHash(value: string): string {
  return value.trim().toLowerCase();
}

/** True for a hash already in the stored form (lower case, 0x plus 64 hex digits). */
export function isValidChainHash(value: string): boolean {
  return CHAIN_HASH_PATTERN.test(value);
}

/** Shape of the evidence columns on a registration row, as the repository reads them. */
export interface WalletRegistrationEvidenceColumns {
  transactionHash?: string | null | undefined;
  blockNumber?: bigint | null | undefined;
  blockHash?: string | null | undefined;
  logIndex?: number | null | undefined;
  verifiedAt?: Date | null | undefined;
  flaggedAt?: Date | null | undefined;
}

/**
 * Classifies a row's evidence: "none" (confirmed before evidence was kept, or
 * not confirmed), "partial" (transaction hash and block number only: written by
 * the manual reconcile before the log index was recorded), "recorded" (the
 * full identity, not yet final), "verified" (the block was deep enough to count
 * as final and still canonical) or "flagged" (the event is no longer on the
 * chain).
 */
export function describeEvidence(columns: WalletRegistrationEvidenceColumns): WalletRegistrationEvidenceStatus {
  if (columns.flaggedAt !== null && columns.flaggedAt !== undefined) return "flagged";
  const hasIdentity =
    isPresent(columns.transactionHash) && isPresent(columns.blockHash) && isPresent(columns.logIndex);
  if (hasIdentity) {
    return columns.verifiedAt !== null && columns.verifiedAt !== undefined ? "verified" : "recorded";
  }
  if (isPresent(columns.transactionHash) || isPresent(columns.blockNumber)) return "partial";
  return "none";
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

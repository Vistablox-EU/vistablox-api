import type { WalletRegistrationEvidence } from "../../../shared/domain/wallet-registration-evidence.js";

// A confirmation whose block is at least this deep is final for this job's
// purposes: the row is marked verified and leaves the re-check set. About 30
// minutes of Base blocks (2 s each), which covers the window in which the
// sequencer's batches can still be disputed in practice. An engineering
// heuristic, not a protocol constant: a read of the chain's `finalized` tag
// would remove the number but needs provider support that has not been
// confirmed on Base Sepolia.
export const WALLET_REGISTRY_EVIDENCE_FINAL_DEPTH = 900n;

// Rows re-checked per run, oldest block first. A handful of registrations is
// the expected population; the cap only bounds the RPC calls of one run.
export const WALLET_REGISTRY_EVIDENCE_RECHECK_BATCH = 50;

/** What the policy needs to know about an already registered row (structural, so the domain imports no repository type). */
export interface RegisteredRowView {
  walletAddress: string;
  transactionHash: string | null;
  blockHash: string | null;
  logIndex: number | null;
  evidenceFlag: string | null;
}

/**
 * What to do with a WalletRegistered event whose commitment belongs to a row
 * that is already registered.
 *  - replay: the same event again (the rescan overlap, a retry after a crash).
 *  - record_evidence: the row has no (or only partial) evidence and this is its
 *    event: fill it in. registered_at is untouched.
 *  - refresh: the row's transaction was mined again, in another block (a
 *    reorganization), or a flagged row's event is on the chain again: replace
 *    the recorded evidence.
 *  - conflict: a different on-chain event for a registration that another
 *    event already confirmed. Nothing is written; the recorded evidence stays.
 */
export type RegisteredRowDecision = "replay" | "record_evidence" | "refresh" | "conflict";

export function decideRegisteredRowEvent(
  record: RegisteredRowView,
  eventWalletAddress: string,
  evidence: WalletRegistrationEvidence,
): RegisteredRowDecision {
  if (record.walletAddress.toLowerCase() !== eventWalletAddress.toLowerCase()) return "conflict";

  const storedTransaction = record.transactionHash?.toLowerCase() ?? null;
  const sameTransaction = storedTransaction !== null && storedTransaction === evidence.transactionHash.toLowerCase();

  if (record.blockHash !== null && record.logIndex !== null) {
    if (!sameTransaction) {
      // A second register() call for the same commitment (the registry is
      // stateless and permissionless). The first event keeps the row. A
      // flagged row is not moved to a different event automatically: that is
      // a staff decision (reconcile).
      return "conflict";
    }
    const sameBlock = record.blockHash.toLowerCase() === evidence.blockHash.toLowerCase();
    if (!sameBlock) return "refresh"; // the transaction was mined again, in another block
    if (record.logIndex !== evidence.logIndex) return "conflict"; // a second matching log in the same transaction
    // Identical event. A flag means the recorded block was believed gone; the
    // same block is canonical again, so the evidence is refreshed (which clears the flag).
    return record.evidenceFlag === null ? "replay" : "refresh";
  }

  if (storedTransaction === null) return "record_evidence"; // confirmed before evidence was kept
  // Transaction hash and block number only (the manual reconcile before log
  // indexes were recorded): complete it from this event if it is the same transaction.
  return sameTransaction ? "record_evidence" : "conflict";
}

/**
 * Where the cursor should go after a run: not past the scanned range, and not
 * past any block whose confirmations changed this run, so the next run reads
 * those blocks again. Never below 0.
 */
export function finalCursor(toBlock: bigint, rewinds: readonly bigint[]): bigint {
  let cursor = toBlock;
  for (const rewind of rewinds) {
    const bounded = rewind < 0n ? 0n : rewind;
    if (bounded < cursor) cursor = bounded;
  }
  return cursor;
}

/**
 * The cursor position that makes the next run read the block of a confirmation
 * that was found reorganized (the block before it, because the scan starts
 * overlap blocks before the cursor anyway), or null when the block is already
 * deeper than the final depth: a rescan that far back would hold up new
 * confirmations for a long time, so such a row is flagged for staff instead.
 */
export function rewindTargetFor(storedBlockNumber: bigint, head: bigint): bigint | null {
  if (head - storedBlockNumber >= WALLET_REGISTRY_EVIDENCE_FINAL_DEPTH) return null;
  return storedBlockNumber > 0n ? storedBlockNumber - 1n : 0n;
}

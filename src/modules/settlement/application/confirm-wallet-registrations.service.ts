import type { ChainClients } from "../../../infrastructure/blockchain/chain-client.js";
import {
  WalletRegistryChainReader,
  type RegistrationEventLookup,
} from "../../../infrastructure/blockchain/wallet-registry-chain-reader.js";
import {
  isValidChainHash,
  normalizeChainHash,
  type WalletRegistrationEvidence,
} from "../../../shared/domain/wallet-registration-evidence.js";
import {
  WALLET_REGISTRY_EVIDENCE_FINAL_DEPTH,
  WALLET_REGISTRY_EVIDENCE_RECHECK_BATCH,
  decideRegisteredRowEvent,
  finalCursor,
  rewindTargetFor,
} from "../domain/wallet-registration-event.policy.js";
import type {
  SettlementRepository,
  WalletRegistrationRecord,
  WalletRegistrationRecheckCandidate,
} from "../repository/settlement.repository.js";

// Bounds each run's eth_getLogs range so a long gap since the last run (a
// deploy, a worker outage) can't exceed an RPC provider's block-range cap in
// one call. At Base's ~2s block time this is a couple hours of blocks --
// comfortably ahead of real-time on the hourly schedule this job runs on
// (worker.ts), and an outage longer than that just takes a few extra runs to
// fully catch up rather than failing outright.
const MAX_BLOCK_RANGE_PER_RUN = 2000n;

// Re-read a small tail of the previous range on every run. RPC providers can
// briefly return incomplete logs while a block is being indexed, and a
// worker restart between reading logs and persisting the cursor must not turn
// that transient gap into a permanently pending wallet.
export const WALLET_REGISTRY_RESCAN_OVERLAP_BLOCKS = 32n;

// Never finalize a registration from a block that may still be re-organized.
// Base has a short confirmation time; three blocks is deliberately modest
// while still keeping the mobile UX responsive.
export const WALLET_REGISTRY_CONFIRMATION_DEPTH = 3n;
export const WALLET_REGISTRY_PENDING_WARN_AFTER_MS = 5 * 60 * 1000;

interface WalletRegisteredEventArgs {
  wallet?: string;
  commitment?: string;
}

// The fields of a log viem returns from eth_getLogs that identify it. They are
// null for a log of a pending block, which is why they are checked rather than
// trusted.
interface WalletRegisteredEvent {
  args: WalletRegisteredEventArgs;
  blockHash?: string | null;
  blockNumber?: bigint | null;
  transactionHash?: string | null;
  logIndex?: number | null;
  removed?: boolean;
}

/** What the re-check needs from the chain; WalletRegistryChainReader is the real one. */
export interface WalletRegistrationEvidenceReader {
  getCanonicalBlockHash(blockNumber: bigint): Promise<string | null>;
  findRegistrationEvent(input: {
    transactionHash: string;
    walletAddress: string;
    commitment: string;
  }): Promise<RegistrationEventLookup>;
}

export interface ConfirmWalletRegistrationsSummary {
  fromBlock: string;
  toBlock: string;
  eventsFound: number;
  registrationsConfirmed: number;
  // An event whose commitment belongs to no registration row at all.
  unmatchedEvents: number;
  addressMismatches: string[];
  pendingRegistrationsOverdue: number;
  pendingWarnAfterMinutes: number;
  // The same event seen again for a row that already holds it (the rescan
  // overlap, a retry after a crash).
  eventsReplayed: number;
  // An event the node did not give a complete identity for (removed, or
  // missing a hash, block number or log index). Never confirmed without it.
  eventsWithoutIdentity: number;
  // A different on-chain event for a row another event already confirmed, or
  // an event another row already backs. Nothing is written for it.
  conflictingEvents: number;
  // Evidence written to a row that was already registered without it.
  evidenceRecorded: number;
  // Evidence replaced because the transaction was mined again in another block.
  evidenceRefreshed: number;
  // A refresh that ran into another row holding the new identity; retried by a later run.
  evidenceRefreshDeferred: number;
  evidenceRechecked: number;
  evidenceVerified: number;
  evidenceFlagged: number;
  evidenceRecheckErrors: number;
  // Set when this run moved the cursor back to re-read blocks whose
  // confirmations changed. Not an error message: viem errors embed the RPC URL,
  // so nothing from a thrown error is put in this summary.
  cursorRewoundTo: string | null;
}

/**
 * AD-241 step 9-10's confirmation half: watches VistaBloxWalletRegistry's
 * WalletRegistered event, matches each one back to the wallet_registrations
 * row that requested it (by registration_commitment -- the one-time opaque
 * value RegisterWalletService handed the mobile app), sanity-checks the
 * on-chain sender against the stored address, and marks registered_at together
 * with the identity of the event (transaction hash, block hash and number, log
 * index) in one statement.
 *
 * Idempotent by construction (AD-241's invariant): a row is confirmed only
 * while registered_at IS NULL, so replaying the same event (an overlapping
 * rescan after a crash between the read and the cursor write) finds the row
 * already registered with the same identity and does nothing. A different
 * event for an already registered row is counted and left alone.
 *
 * Reorganizations: after the events, the job compares the block recorded for
 * each recent confirmation with the chain. A transaction that was mined again
 * gets its evidence refreshed; one that is gone is flagged, never reverted
 * (registered_at stays: the registry holds no state, the wallet's signature is
 * what proved control, and releasing the registration would let the address be
 * claimed twice). Either way the cursor is moved back so the next run reads the
 * blocks again.
 */
export class ConfirmWalletRegistrationsService {
  private readonly evidenceReaderOverride: WalletRegistrationEvidenceReader | undefined;
  private defaultEvidenceReader: WalletRegistrationEvidenceReader | undefined;

  public constructor(
    private readonly repository: SettlementRepository,
    private readonly chain: ChainClients,
    private readonly clock: () => Date = () => new Date(),
    private readonly pendingWarnAfterMs = WALLET_REGISTRY_PENDING_WARN_AFTER_MS,
    evidenceReader?: WalletRegistrationEvidenceReader,
  ) {
    this.evidenceReaderOverride = evidenceReader;
  }

  // Built on first use so constructing the service never touches the chain
  // configuration (ChainClients.walletRegistry throws without an address).
  private get evidenceReader(): WalletRegistrationEvidenceReader {
    if (this.evidenceReaderOverride !== undefined) return this.evidenceReaderOverride;
    this.defaultEvidenceReader ??= new WalletRegistryChainReader(
      this.chain.publicClient,
      this.chain.walletRegistry.address,
    );
    return this.defaultEvidenceReader;
  }

  public async execute(): Promise<ConfirmWalletRegistrationsSummary> {
    const latestBlock = await this.chain.publicClient.getBlockNumber();
    const cursor = await this.repository.getLastProcessedWalletRegistryBlock();
    const now = this.clock();
    const pendingRegistrationsOverdue = await this.repository.countPendingWalletRegistrationsBefore(
      new Date(now.getTime() - this.pendingWarnAfterMs),
    );
    const safeLatestBlock = latestBlock - WALLET_REGISTRY_CONFIRMATION_DEPTH;
    // No cursor yet: start at the latest *safe* block rather than the head.
    // Subsequent runs overlap the cursor tail so an indexed-log race or
    // crash cannot strand a registration forever.
    const fromBlock =
      cursor === null
        ? safeLatestBlock
        : cursor > WALLET_REGISTRY_RESCAN_OVERLAP_BLOCKS
          ? cursor - WALLET_REGISTRY_RESCAN_OVERLAP_BLOCKS + 1n
          : 0n;

    const summary: ConfirmWalletRegistrationsSummary = {
      fromBlock: fromBlock.toString(),
      toBlock: safeLatestBlock.toString(),
      eventsFound: 0,
      registrationsConfirmed: 0,
      unmatchedEvents: 0,
      addressMismatches: [],
      pendingRegistrationsOverdue,
      pendingWarnAfterMinutes: Math.round(this.pendingWarnAfterMs / 60_000),
      eventsReplayed: 0,
      eventsWithoutIdentity: 0,
      conflictingEvents: 0,
      evidenceRecorded: 0,
      evidenceRefreshed: 0,
      evidenceRefreshDeferred: 0,
      evidenceRechecked: 0,
      evidenceVerified: 0,
      evidenceFlagged: 0,
      evidenceRecheckErrors: 0,
      cursorRewoundTo: null,
    };

    if (safeLatestBlock < 0n || fromBlock > safeLatestBlock) {
      return summary;
    }

    const toBlock =
      safeLatestBlock - fromBlock > MAX_BLOCK_RANGE_PER_RUN
        ? fromBlock + MAX_BLOCK_RANGE_PER_RUN
        : safeLatestBlock;
    summary.toBlock = toBlock.toString();

    // Two arguments: the indexed-argument filter (none), then the block range.
    // With one argument viem reads the object as the filter for an event that
    // has indexed inputs, sends eth_getLogs without a range and finds nothing.
    const events = (await this.chain.walletRegistry.getEvents.WalletRegistered!(
      {},
      { fromBlock, toBlock },
    )) as unknown as ReadonlyArray<WalletRegisteredEvent>;
    summary.eventsFound = events.length;

    for (const event of events) {
      const { wallet, commitment } = event.args;
      if (wallet === undefined || commitment === undefined) {
        continue; // Defensive only -- the ABI guarantees both are present.
      }
      await this.processEvent(event, wallet, commitment, summary);
    }

    const rewinds = await this.recheckEvidence(latestBlock, summary);

    const cursorAfter = finalCursor(toBlock, rewinds);
    if (cursorAfter < toBlock) summary.cursorRewoundTo = cursorAfter.toString();
    await this.repository.setLastProcessedWalletRegistryBlock(cursorAfter);

    return summary;
  }

  private async processEvent(
    event: WalletRegisteredEvent,
    wallet: string,
    commitment: string,
    summary: ConfirmWalletRegistrationsSummary,
  ): Promise<void> {
    const evidence = toEvidence(event);
    const record = await this.repository.findWalletRegistrationByCommitment(commitment);
    if (record === null) {
      summary.unmatchedEvents += 1;
      return;
    }

    if (record.registeredAt === null) {
      await this.processPendingEvent(record, evidence, wallet, commitment, summary);
      return;
    }
    await this.processRegisteredEvent(record, evidence, wallet, summary);
  }

  private async processPendingEvent(
    record: WalletRegistrationRecord,
    evidence: WalletRegistrationEvidence | null,
    wallet: string,
    commitment: string,
    summary: ConfirmWalletRegistrationsSummary,
  ): Promise<void> {
    if (record.walletAddress.toLowerCase() !== wallet.toLowerCase()) {
      summary.addressMismatches.push(
        `account_id=${record.accountId} commitment=${commitment}: stored wallet ${record.walletAddress} != on-chain sender ${wallet}`,
      );
      // Durable record, not just the log line worker.ts emits from this
      // summary -- a log scrolls away; this is what a support/security
      // review actually queries later.
      await this.repository.recordWalletRegistrationAddressMismatch({
        accountId: record.accountId,
        commitment,
        storedWalletAddress: record.walletAddress,
        onChainSender: wallet,
        detectedAt: this.clock(),
      });
      return;
    }

    if (evidence === null) {
      // Never confirm without the event's identity: that would recreate the
      // blank-evidence rows this job exists to avoid. The row stays pending;
      // the overdue count and the manual reconcile cover it.
      summary.eventsWithoutIdentity += 1;
      return;
    }

    const outcome = await this.repository.confirmWalletRegistration({
      accountId: record.accountId,
      registeredAt: this.clock(),
      evidence,
    });
    if (outcome === "confirmed") {
      summary.registrationsConfirmed += 1;
    } else if (outcome === "event_taken") {
      summary.conflictingEvents += 1;
    } else {
      // Another run (or the manual reconcile) confirmed the row between the
      // read and the write. Classify against what it holds now, once.
      const reread = await this.repository.findWalletRegistrationByCommitment(commitment);
      if (reread !== null && reread.registeredAt !== null) {
        await this.processRegisteredEvent(reread, evidence, wallet, summary);
      }
    }
  }

  private async processRegisteredEvent(
    record: WalletRegistrationRecord,
    evidence: WalletRegistrationEvidence | null,
    wallet: string,
    summary: ConfirmWalletRegistrationsSummary,
  ): Promise<void> {
    if (evidence === null) {
      summary.eventsWithoutIdentity += 1;
      return;
    }
    const decision = decideRegisteredRowEvent(record, wallet, evidence);
    if (decision === "replay") {
      summary.eventsReplayed += 1;
      return;
    }
    if (decision === "conflict") {
      // No mismatch audit row: whether and how to record a second event for a
      // confirmed registration is a policy of its own.
      summary.conflictingEvents += 1;
      return;
    }
    const outcome = await this.repository.replaceWalletRegistrationEvidence({
      accountId: record.accountId,
      expected: { transactionHash: record.transactionHash, blockHash: record.blockHash, logIndex: record.logIndex },
      next: evidence,
      reason: decision === "record_evidence" ? "recorded" : "refreshed",
      changedAt: this.clock(),
    });
    if (outcome === "replaced") {
      if (decision === "record_evidence") summary.evidenceRecorded += 1;
      else summary.evidenceRefreshed += 1;
    } else if (outcome === "event_taken") {
      // A reorganization that shifts log indexes can make this row's new
      // identity equal another row's old one until that row is refreshed too.
      // The next run retries.
      summary.evidenceRefreshDeferred += 1;
    }
    // "stale": another run changed the row first; nothing left to do here.
  }

  /**
   * Compares the recorded block of recent confirmations with the chain.
   * Returns the cursor positions that make the next run re-read the blocks
   * whose confirmations changed. Each row is handled on its own: one that
   * fails is counted and never stops the others or the cursor write.
   */
  private async recheckEvidence(head: bigint, summary: ConfirmWalletRegistrationsSummary): Promise<bigint[]> {
    const rewinds: bigint[] = [];
    const candidates = await this.repository.listWalletRegistrationsForEvidenceRecheck(
      WALLET_REGISTRY_EVIDENCE_RECHECK_BATCH,
    );
    for (const candidate of candidates) {
      summary.evidenceRechecked += 1;
      try {
        const rewind = await this.recheckOne(candidate, head, summary);
        if (rewind !== null) rewinds.push(rewind);
      } catch {
        // Not logged with its message: viem errors embed the RPC URL.
        summary.evidenceRecheckErrors += 1;
      }
    }
    return rewinds;
  }

  private async recheckOne(
    candidate: WalletRegistrationRecheckCandidate,
    head: bigint,
    summary: ConfirmWalletRegistrationsSummary,
  ): Promise<bigint | null> {
    const { evidence } = candidate;
    const expected = {
      transactionHash: evidence.transactionHash,
      blockHash: evidence.blockHash,
      logIndex: evidence.logIndex,
    };

    const canonical = await this.evidenceReader.getCanonicalBlockHash(evidence.blockNumber);
    if (canonical === null) {
      // The node does not have the block (lagging, or pruned): no verdict.
      summary.evidenceRecheckErrors += 1;
      return null;
    }

    if (canonical === evidence.blockHash.toLowerCase()) {
      // Still canonical. Final once deep enough; otherwise look again next run.
      if (head - evidence.blockNumber >= WALLET_REGISTRY_EVIDENCE_FINAL_DEPTH) {
        const marked = await this.repository.markWalletRegistrationEvidenceVerified({
          accountId: candidate.accountId,
          expected,
          verifiedAt: this.clock(),
        });
        if (marked) summary.evidenceVerified += 1;
      }
      return null;
    }

    // The block at that height is not the one recorded. Ask where the
    // transaction is now.
    const rewind = rewindTargetFor(evidence.blockNumber, head);
    const lookup = await this.evidenceReader.findRegistrationEvent({
      transactionHash: evidence.transactionHash,
      walletAddress: candidate.walletAddress,
      commitment: candidate.registrationCommitment,
    });

    if (lookup.kind === "found") {
      if (lookup.evidence.blockHash.toLowerCase() === evidence.blockHash.toLowerCase()) {
        // The node contradicts itself (the block at that height differs, yet
        // the receipt sits in the recorded block): no verdict, no flag.
        summary.evidenceRecheckErrors += 1;
        return null;
      }
      if (head - lookup.evidence.blockNumber < WALLET_REGISTRY_CONFIRMATION_DEPTH) {
        return rewind; // mined again but not deep enough to record yet; look again later
      }
      const outcome = await this.repository.replaceWalletRegistrationEvidence({
        accountId: candidate.accountId,
        expected,
        next: lookup.evidence,
        reason: "refreshed",
        changedAt: this.clock(),
      });
      if (outcome === "replaced") summary.evidenceRefreshed += 1;
      else if (outcome === "event_taken") summary.evidenceRefreshDeferred += 1;
      return rewind;
    }

    const flagged = await this.repository.flagWalletRegistrationEvidence({
      accountId: candidate.accountId,
      expected,
      flag:
        lookup.kind === "transaction_not_found"
          ? "transaction_missing"
          : lookup.kind === "transaction_reverted"
            ? "transaction_reverted"
            : "event_missing",
      flaggedAt: this.clock(),
    });
    if (flagged) summary.evidenceFlagged += 1;
    return rewind;
  }
}

// The event's identity as the stored form wants it, or null when the node did
// not give a complete one (a removed log, a log of a pending block) or gave
// something that is not a hash.
function toEvidence(event: WalletRegisteredEvent): WalletRegistrationEvidence | null {
  if (event.removed === true) return null;
  const { transactionHash, blockHash, blockNumber, logIndex } = event;
  if (typeof transactionHash !== "string" || typeof blockHash !== "string") return null;
  if (typeof blockNumber !== "bigint" || blockNumber < 0n) return null;
  if (typeof logIndex !== "number" || !Number.isInteger(logIndex) || logIndex < 0) return null;
  const normalizedTransaction = normalizeChainHash(transactionHash);
  const normalizedBlock = normalizeChainHash(blockHash);
  if (!isValidChainHash(normalizedTransaction) || !isValidChainHash(normalizedBlock)) return null;
  return { transactionHash: normalizedTransaction, blockHash: normalizedBlock, blockNumber, logIndex };
}

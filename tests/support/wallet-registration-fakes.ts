import { vi } from "vitest";

import type { RegistrationEventLookup } from "../../src/infrastructure/blockchain/wallet-registry-chain-reader.js";
import type { WalletRegistrationEvidenceReader } from "../../src/modules/settlement/application/confirm-wallet-registrations.service.js";
import type {
  ConfirmWalletRegistrationInput,
  PivPendingEscrowResolution,
  SettlementRepository,
  WalletRegistrationAddressMismatchInput,
  WalletRegistrationConfirmation,
  WalletRegistrationEvidenceKey,
  WalletRegistrationEvidenceReplacement,
  WalletRegistrationRecheckCandidate,
  WalletRegistrationRecord,
} from "../../src/modules/settlement/repository/settlement.repository.js";
import type {
  WalletRegistrationEvidence,
  WalletRegistrationEvidenceFlag,
} from "../../src/shared/domain/wallet-registration-evidence.js";

export const hash = (byte: string): string => `0x${byte.repeat(32)}`;

export interface FakeEvent {
  blockNumber: bigint;
  wallet: string;
  commitment: string;
  // Defaults derive a distinct, valid identity from the block number, so tests
  // that do not care about it still give the job a complete one.
  transactionHash?: string | null;
  blockHash?: string | null;
  logIndex?: number | null;
  removed?: boolean;
}

function defaultHash(prefix: string, blockNumber: bigint): string {
  return `0x${prefix}${blockNumber.toString(16).padStart(2, "0")}`.padEnd(66, "0");
}

/** The transaction and block hash makeFakeChain gives an event in this block unless a test sets them. */
export const defaultTransactionHash = (blockNumber: bigint): string => defaultHash("11", blockNumber);
export const defaultBlockHash = (blockNumber: bigint): string => defaultHash("22", blockNumber);

/**
 * A stand-in for the ChainClients slice the watcher uses. The log query has the
 * signature of viem's getEvents for an event with indexed inputs: (filter,
 * options). Called with one argument it would not apply the block range (viem
 * reads that argument as the filter), so this fake refuses it rather than
 * quietly accepting the shape that finds nothing against a real node.
 */
export function makeFakeChain(options: { latestBlock: bigint; events: FakeEvent[]; failGetEvents?: boolean }) {
  const getEventsCalls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  return {
    chain: {
      publicClient: {
        getBlockNumber: vi.fn(async () => options.latestBlock),
      },
      walletRegistry: {
        address: `0x${"e".repeat(40)}`,
        getEvents: {
          WalletRegistered: vi.fn(
            async (
              _filter: Record<string, never>,
              range?: { fromBlock: bigint; toBlock: bigint },
            ) => {
              if (range === undefined) {
                throw new Error("getEvents.WalletRegistered needs (filter, { fromBlock, toBlock }): one argument is read as the indexed-argument filter");
              }
              const { fromBlock, toBlock } = range;
              getEventsCalls.push({ fromBlock, toBlock });
              if (options.failGetEvents) throw new Error("RPC log query failed");
              return options.events
                .filter((event) => event.blockNumber >= fromBlock && event.blockNumber <= toBlock)
                .map((event, index) => ({
                  args: { wallet: event.wallet, commitment: event.commitment },
                  transactionHash:
                    event.transactionHash === undefined ? defaultHash("11", event.blockNumber) : event.transactionHash,
                  blockHash: event.blockHash === undefined ? defaultHash("22", event.blockNumber) : event.blockHash,
                  blockNumber: event.blockNumber,
                  logIndex: event.logIndex === undefined ? index : event.logIndex,
                  removed: event.removed ?? false,
                }));
            },
          ),
        },
      },
    },
    getEventsCalls,
  };
}

export interface FakeRegistrationRow {
  accountId: string;
  walletAddress: string;
  commitment: string;
  registeredAt: Date | null;
  transactionHash: string | null;
  blockNumber: bigint | null;
  blockHash: string | null;
  logIndex: number | null;
  verifiedAt: Date | null;
  flaggedAt: Date | null;
  flag: WalletRegistrationEvidenceFlag | null;
}

export type FakeRegistrationSeed = Partial<FakeRegistrationRow> & {
  accountId: string;
  walletAddress: string;
  commitment: string;
};

export interface RecordedWrite {
  method: string;
  accountId: string;
  detail: Record<string, unknown>;
}

/**
 * An in-memory model of wallet_registrations and the cursor setting, with the
 * semantics the real repository guarantees: confirm only applies to the exact
 * pending claim it names (address and commitment), a (transaction hash, log
 * index) pair backs one row, every other write is a compare-and-set on the
 * identity it expects. Not canned return values, so a
 * test fails when the service sequences its calls wrongly.
 */
export class FakeWalletRegistrationRepository implements SettlementRepository {
  public readonly rows = new Map<string, FakeRegistrationRow>();
  public readonly writes: RecordedWrite[] = [];
  public readonly recordedMismatches: WalletRegistrationAddressMismatchInput[] = [];
  public readonly cursorWrites: bigint[] = [];
  /** Every confirmWalletRegistration call, as made: the claim it names and the event it carries. */
  public readonly confirmCalls: ConfirmWalletRegistrationInput[] = [];
  /**
   * Makes confirmWalletRegistration answer this without writing, for an outcome
   * the model cannot reach on its own (address_conflict: the confirmed-address
   * unique index lives in the database).
   */
  public forcedConfirmOutcome: WalletRegistrationConfirmation | undefined;
  public overdueCutoff: Date | undefined;
  /** Runs once, right before the next confirm applies: a way to model a concurrent run. */
  public beforeNextConfirm: (() => void) | undefined;
  public failSetCursor = false;
  public failListRecheck = false;
  private cursor: bigint | null;
  private readonly overdueCount: number;

  public constructor(seeds: FakeRegistrationSeed[] = [], initialCursor: bigint | null = null, overdueCount = 0) {
    this.cursor = initialCursor;
    this.overdueCount = overdueCount;
    for (const seed of seeds) this.addRow(seed);
  }

  public addRow(seed: FakeRegistrationSeed): FakeRegistrationRow {
    const row: FakeRegistrationRow = {
      registeredAt: null,
      transactionHash: null,
      blockNumber: null,
      blockHash: null,
      logIndex: null,
      verifiedAt: null,
      flaggedAt: null,
      flag: null,
      ...seed,
    };
    this.rows.set(row.accountId, row);
    return row;
  }

  public row(accountId: string): FakeRegistrationRow {
    const row = this.rows.get(accountId);
    if (row === undefined) throw new Error(`no row ${accountId}`);
    return row;
  }

  public writesOf(method: string): RecordedWrite[] {
    return this.writes.filter((write) => write.method === method);
  }

  public get confirmedAccountIds(): string[] {
    return this.writesOf("confirm").map((write) => write.accountId);
  }

  public async findWalletRegistrationByCommitment(commitment: string): Promise<WalletRegistrationRecord | null> {
    for (const row of this.rows.values()) {
      if (row.commitment.toLowerCase() === commitment.toLowerCase()) return toRecord(row);
    }
    return null;
  }

  public async confirmWalletRegistration(input: ConfirmWalletRegistrationInput): Promise<WalletRegistrationConfirmation> {
    const hook = this.beforeNextConfirm;
    this.beforeNextConfirm = undefined;
    hook?.();
    this.confirmCalls.push(input);
    if (this.forcedConfirmOutcome !== undefined) return this.forcedConfirmOutcome;
    // Compare-and-set on the exact claim the event was matched to: a row the
    // account replaced (another address or commitment) is not the claim, and is
    // told apart from the same claim confirmed meanwhile.
    const row = this.rows.get(input.accountId);
    if (row === undefined || row.walletAddress !== input.walletAddress || row.commitment !== input.registrationCommitment) {
      return "stale";
    }
    if (row.registeredAt !== null) return "already_registered";
    if (this.holderOf(input.evidence.transactionHash, input.evidence.logIndex, input.accountId) !== null) {
      return "event_taken";
    }
    row.registeredAt = input.registeredAt;
    applyEvidence(row, input.evidence);
    this.writes.push({ method: "confirm", accountId: input.accountId, detail: { evidence: input.evidence } });
    return "confirmed";
  }

  public async replaceWalletRegistrationEvidence(input: {
    accountId: string;
    expected: WalletRegistrationEvidenceKey;
    next: WalletRegistrationEvidence;
    reason: "recorded" | "refreshed";
    changedAt: Date;
  }): Promise<WalletRegistrationEvidenceReplacement> {
    const row = this.row(input.accountId);
    if (row.registeredAt === null || !holdsKey(row, input.expected)) return "stale";
    if (this.holderOf(input.next.transactionHash, input.next.logIndex, input.accountId) !== null) return "event_taken";
    const previousFlag = row.flag;
    applyEvidence(row, input.next);
    row.verifiedAt = null;
    row.flaggedAt = null;
    row.flag = null;
    this.writes.push({
      method: `replace:${input.reason}`,
      accountId: input.accountId,
      detail: { next: input.next, previousFlag },
    });
    return "replaced";
  }

  public async markWalletRegistrationEvidenceVerified(input: {
    accountId: string;
    expected: WalletRegistrationEvidenceKey;
    verifiedAt: Date;
  }): Promise<boolean> {
    const row = this.row(input.accountId);
    if (row.registeredAt === null || !holdsKey(row, input.expected) || row.verifiedAt !== null || row.flaggedAt !== null) {
      return false;
    }
    row.verifiedAt = input.verifiedAt;
    this.writes.push({ method: "verify", accountId: input.accountId, detail: {} });
    return true;
  }

  public async flagWalletRegistrationEvidence(input: {
    accountId: string;
    expected: WalletRegistrationEvidenceKey;
    flag: WalletRegistrationEvidenceFlag;
    flaggedAt: Date;
  }): Promise<boolean> {
    const row = this.row(input.accountId);
    if (row.registeredAt === null || !holdsKey(row, input.expected) || row.flaggedAt !== null) return false;
    row.flaggedAt = input.flaggedAt;
    row.flag = input.flag;
    this.writes.push({ method: "flag", accountId: input.accountId, detail: { flag: input.flag } });
    return true;
  }

  public async listWalletRegistrationsForEvidenceRecheck(limit: number): Promise<WalletRegistrationRecheckCandidate[]> {
    if (this.failListRecheck) throw new Error("list failed");
    return [...this.rows.values()]
      .filter((row) => row.blockHash !== null && row.verifiedAt === null && row.flaggedAt === null)
      .sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)))
      .slice(0, limit)
      .map((row) => ({
        accountId: row.accountId,
        walletAddress: row.walletAddress,
        registrationCommitment: row.commitment,
        evidence: {
          transactionHash: row.transactionHash!,
          blockHash: row.blockHash!,
          blockNumber: row.blockNumber!,
          logIndex: row.logIndex!,
        },
      }));
  }

  public async countPendingWalletRegistrationsBefore(cutoff: Date): Promise<number> {
    this.overdueCutoff = cutoff;
    return this.overdueCount;
  }

  public async recordWalletRegistrationAddressMismatch(input: WalletRegistrationAddressMismatchInput): Promise<void> {
    this.recordedMismatches.push(input);
  }

  public async getLastProcessedWalletRegistryBlock(): Promise<bigint | null> {
    return this.cursor;
  }

  public async setLastProcessedWalletRegistryBlock(block: bigint): Promise<void> {
    if (this.failSetCursor) throw new Error("cursor write failed");
    this.cursor = block;
    this.cursorWrites.push(block);
  }

  // Unused by the watcher suites -- escrow finalize-and-mint only.
  public async findPivsWithPassedIpoDeadline(): Promise<PivPendingEscrowResolution[]> {
    return [];
  }
  public async resolveAccountIdForWallet(): Promise<string | null> {
    return null;
  }
  public async hasPosition(): Promise<boolean> {
    return false;
  }
  public async findEscrowMintIntent(): Promise<null> {
    return null;
  }
  public async createEscrowMintIntent(): Promise<never> {
    throw new Error("unused");
  }
  public async restartEscrowMintAttempt(): Promise<boolean> {
    return false;
  }
  public async recordEscrowMintSent(): Promise<void> {}
  public async recordEscrowMintedPosition(): Promise<{ positionId: string }> {
    return { positionId: "unused" };
  }

  private holderOf(transactionHash: string, logIndex: number, exceptAccountId: string): string | null {
    for (const row of this.rows.values()) {
      if (row.accountId === exceptAccountId) continue;
      if (row.transactionHash === transactionHash && row.logIndex === logIndex) return row.accountId;
    }
    return null;
  }
}

function applyEvidence(row: FakeRegistrationRow, evidence: WalletRegistrationEvidence): void {
  row.transactionHash = evidence.transactionHash;
  row.blockNumber = evidence.blockNumber;
  row.blockHash = evidence.blockHash;
  row.logIndex = evidence.logIndex;
}

function holdsKey(row: FakeRegistrationRow, key: WalletRegistrationEvidenceKey): boolean {
  return row.transactionHash === key.transactionHash && row.blockHash === key.blockHash && row.logIndex === key.logIndex;
}

function toRecord(row: FakeRegistrationRow): WalletRegistrationRecord {
  return {
    accountId: row.accountId,
    walletAddress: row.walletAddress,
    registrationCommitment: row.commitment,
    registeredAt: row.registeredAt,
    transactionHash: row.transactionHash,
    blockNumber: row.blockNumber,
    blockHash: row.blockHash,
    logIndex: row.logIndex,
    evidenceFlag: row.flag,
  };
}

/** A recorded confirmation, as the watcher leaves a row it confirmed. */
export function confirmedRow(
  seed: FakeRegistrationSeed,
  evidence: WalletRegistrationEvidence,
  registeredAt = new Date("2026-11-13T10:00:00.000Z"),
): FakeRegistrationSeed {
  return {
    ...seed,
    registeredAt,
    transactionHash: evidence.transactionHash,
    blockNumber: evidence.blockNumber,
    blockHash: evidence.blockHash,
    logIndex: evidence.logIndex,
  };
}

/**
 * A scriptable stand-in for the chain reader the re-check uses: the canonical
 * hash per height and the lookup result per transaction.
 */
export class FakeEvidenceReader implements WalletRegistrationEvidenceReader {
  public readonly canonicalHashes = new Map<bigint, string | null | Error>();
  public readonly lookups = new Map<string, RegistrationEventLookup | Error>();
  public readonly lookupCalls: Array<{ transactionHash: string; walletAddress: string; commitment: string }> = [];
  public readonly hashCalls: bigint[] = [];

  // Unless a test scripts a height, the chain agrees with what makeFakeChain
  // reported for it.
  public async getCanonicalBlockHash(blockNumber: bigint): Promise<string | null> {
    this.hashCalls.push(blockNumber);
    const entry = this.canonicalHashes.has(blockNumber) ? this.canonicalHashes.get(blockNumber) : defaultBlockHash(blockNumber);
    if (entry instanceof Error) throw entry;
    return entry ?? null;
  }

  public async findRegistrationEvent(input: {
    transactionHash: string;
    walletAddress: string;
    commitment: string;
  }): Promise<RegistrationEventLookup> {
    this.lookupCalls.push(input);
    // A transaction that holds several registrations is scripted per commitment
    // ("<transaction hash>:<commitment>"); otherwise per transaction.
    const entry = this.lookups.get(`${input.transactionHash}:${input.commitment}`) ?? this.lookups.get(input.transactionHash);
    if (entry instanceof Error) throw entry;
    if (entry === undefined) throw new Error(`no scripted lookup for ${input.transactionHash}`);
    return entry;
  }
}

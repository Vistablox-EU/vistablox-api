import { vi } from "vitest";
import type { Logger } from "pino";

import type {
  CreateEscrowMintIntentInput,
  EscrowMintIntent,
  PivPendingEscrowResolution,
  RecordEscrowMintedPositionInput,
  SettlementRepository,
} from "../../src/modules/settlement/repository/settlement.repository.js";

export const CAMPAIGN_STATE_OPEN = 1;
export const CAMPAIGN_STATE_SUCCESSFUL = 2;
export const CAMPAIGN_STATE_FAILED = 3;

export const PROPERTY_CONTRACT = "0xPROPERTY0000000000000000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface FakeCampaign {
  targetAmount: bigint;
  totalRaised: bigint;
  deadline: bigint;
  treasury: string;
  state: number;
  swept: boolean;
}

/**
 * What the next write.mint call does, from the point of view of the caller:
 *   mine               accepted and mined; the hash is returned
 *   revert             accepted and mined but reverted; the hash is returned
 *   pending            accepted but not mined yet (see FakeEscrowChain.mineNextPending)
 *   reject             rejected before reaching the node: no transaction exists
 *   mine-then-reject   accepted and mined, but the call rejects (an RPC timeout, or the
 *                      process dying right after the node accepted it): the caller never
 *                      sees the hash
 *   replaced           accepted, then replaced in the mempool by another transaction from the
 *                      same account and nonce: the mint never executes, and waiting for the
 *                      returned hash resolves with the REPLACEMENT's receipt (as viem's
 *                      waitForTransactionReceipt does), while looking the hash up directly
 *                      finds no receipt
 */
export type MintMode = "mine" | "revert" | "pending" | "reject" | "mine-then-reject" | "replaced";

interface FakeTransaction {
  status: "success" | "reverted" | "pending";
  apply?: () => void;
}

interface FakeTransferLog {
  blockNumber: bigint;
  args: { operator: string; from: string; to: string; id: bigint; value: bigint };
  transactionHash: string;
}

class FakeReceiptNotFoundError extends Error {
  public override readonly name = "TransactionReceiptNotFoundError";
}

/**
 * A small in-memory model of VistaBloxIpoEscrow + VistaBloxProperty, not just
 * canned return values: mint really changes a balance, a transaction really
 * has a status, and the TransferSingle log a mint emits is really queryable,
 * so the reconciliation logic under test is driving real state transitions.
 * `timeline` (shared with the repository fake) records the order in which the
 * service touched the chain and the database.
 */
export class FakeEscrowChain {
  public blockNumber = 1_000n;
  public readonly balances = new Map<string, bigint>();
  public readonly authorizedHolders = new Set<string>();
  public readonly transactions = new Map<string, FakeTransaction>();
  public readonly transferLogs: FakeTransferLog[] = [];
  // Every write.mint call that reached the node (a "reject" never does).
  public readonly mints: Array<{ hash: string; to: string; tokenId: bigint; amount: bigint }> = [];
  public readonly mintModes: MintMode[] = [];
  // hash -> the hash of the transaction that replaced it (see MintMode "replaced").
  public readonly replacements = new Map<string, string>();
  // Called inside write.mint, after the call is made and before it returns.
  public onMint: (() => void) | undefined;
  public failWithdrawRaisedOnce = false;
  public authorizeReverts = false;
  private txCounter = 0;

  public readonly config = { propertyContractAddress: PROPERTY_CONTRACT };

  public constructor(
    private readonly campaigns: Map<string, FakeCampaign>,
    private readonly contributions: Map<string, Map<string, bigint>>,
    private readonly contributors: Map<string, string[]>,
    private readonly timeline: string[] = [],
  ) {}

  public balanceOf(wallet: string, tokenId: bigint): bigint {
    return this.balances.get(this.balanceKey(wallet, tokenId)) ?? 0n;
  }

  /**
   * A mint that already happened on-chain without any database record -- what the
   * job leaves behind when it dies between sending a mint and writing the position
   * (and, before intents existed, left no trace of at all).
   */
  public seedUnrecordedMint(to: string, tokenId: bigint, amount: bigint): string {
    const hash = this.nextHash();
    this.mints.push({ hash, to, tokenId, amount });
    this.applyMint(hash, to, tokenId, amount);
    this.transactions.set(hash, { status: "success" });
    return hash;
  }

  /** Mines the oldest still-pending transaction, applying its effect. */
  public mineNextPending(): string {
    const entry = [...this.transactions.entries()].find(([, tx]) => tx.status === "pending");
    if (entry === undefined) throw new Error("no pending transaction to mine");
    const [hash, tx] = entry;
    tx.status = "success";
    tx.apply?.();
    return hash;
  }

  public readonly publicClient = {
    getBlockNumber: vi.fn(async () => this.blockNumber),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => {
      this.timeline.push(`chain:waitForReceipt(${hash})`);
      const tx = this.transactions.get(hash);
      const replacement = this.replacements.get(hash);
      if (replacement !== undefined) return { status: "success", transactionHash: replacement };
      if (tx === undefined || tx.status === "pending") {
        throw new Error(`timed out waiting for transaction ${hash}`);
      }
      return { status: tx.status, transactionHash: hash };
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => {
      const tx = this.transactions.get(hash);
      if (tx === undefined || tx.status === "pending") throw new FakeReceiptNotFoundError(hash);
      return { status: tx.status };
    }),
  };

  public readonly ipoEscrow = {
    read: {
      campaignOf: vi.fn(async ([tokenId]: [bigint]) => {
        const campaign = this.campaigns.get(tokenId.toString())!;
        return [
          campaign.targetAmount,
          campaign.totalRaised,
          campaign.deadline,
          campaign.treasury,
          campaign.state,
          campaign.swept,
        ] as const;
      }),
      contributorsOf: vi.fn(async ([tokenId]: [bigint]) => this.contributors.get(tokenId.toString()) ?? []),
      contributionOf: vi.fn(
        async ([tokenId, address]: [bigint, string]) =>
          this.contributions.get(tokenId.toString())?.get(address) ?? 0n,
      ),
    },
    write: {
      finalize: vi.fn(async ([tokenId]: [bigint]) => {
        const campaign = this.campaigns.get(tokenId.toString())!;
        campaign.state =
          campaign.totalRaised >= campaign.targetAmount ? CAMPAIGN_STATE_SUCCESSFUL : CAMPAIGN_STATE_FAILED;
        return this.sendConfirmedTransaction();
      }),
      withdrawRaised: vi.fn(async ([tokenId]: [bigint]) => {
        if (this.failWithdrawRaisedOnce) {
          this.failWithdrawRaisedOnce = false;
          throw new Error("process died before the sweep");
        }
        this.campaigns.get(tokenId.toString())!.swept = true;
        return this.sendConfirmedTransaction();
      }),
    },
  };

  public readonly property = {
    read: {
      balanceOf: vi.fn(async ([wallet, tokenId]: [string, bigint]) => this.balanceOf(wallet, tokenId)),
      isHolderAuthorized: vi.fn(async ([wallet, tokenId]: [string, bigint]) =>
        this.authorizedHolders.has(this.balanceKey(wallet, tokenId)),
      ),
    },
    write: {
      authorizeHolder: vi.fn(async ([wallet, tokenId]: [string, bigint]) => {
        if (this.authorizeReverts) {
          const hash = this.nextHash();
          this.transactions.set(hash, { status: "reverted" });
          return hash;
        }
        this.authorizedHolders.add(this.balanceKey(wallet, tokenId));
        return this.sendConfirmedTransaction();
      }),
      mint: vi.fn(async ([to, tokenId, amount]: [string, bigint, bigint, string]) => {
        this.timeline.push("chain:mint");
        const mode = this.mintModes.shift() ?? "mine";
        if (mode === "reject") throw new Error("RPC error: connection refused");

        const hash = this.nextHash();
        this.mints.push({ hash, to, tokenId, amount });
        const apply = () => this.applyMint(hash, to, tokenId, amount);
        if (mode === "revert") {
          this.transactions.set(hash, { status: "reverted" });
        } else if (mode === "pending") {
          this.transactions.set(hash, { status: "pending", apply });
        } else if (mode === "replaced") {
          this.transactions.set(hash, { status: "pending", apply });
          this.replacements.set(hash, `${hash}-replacement`);
        } else {
          apply();
          this.transactions.set(hash, { status: "success" });
        }
        this.onMint?.();
        if (mode === "mine-then-reject") throw new Error("RPC error: request timed out");
        return hash;
      }),
    },
    getEvents: {
      TransferSingle: vi.fn(
        async ({ from, to }: { from: string; to: string }, { fromBlock }: { fromBlock: bigint }) =>
          this.transferLogs.filter(
            (log) =>
              log.args.from.toLowerCase() === from.toLowerCase() &&
              log.args.to.toLowerCase() === to.toLowerCase() &&
              log.blockNumber >= fromBlock,
          ),
      ),
    },
  };

  private applyMint(hash: string, to: string, tokenId: bigint, amount: bigint): void {
    const key = this.balanceKey(to, tokenId);
    this.balances.set(key, (this.balances.get(key) ?? 0n) + amount);
    this.blockNumber += 1n;
    this.transferLogs.push({
      blockNumber: this.blockNumber,
      args: { operator: "0xOPERATOR", from: ZERO_ADDRESS, to, id: tokenId, value: amount },
      transactionHash: hash,
    });
  }

  private balanceKey(wallet: string, tokenId: bigint): string {
    return `${wallet.toLowerCase()}:${tokenId}`;
  }

  private nextHash(): string {
    return `0xtx${++this.txCounter}`;
  }

  private sendConfirmedTransaction(): string {
    const hash = this.nextHash();
    this.transactions.set(hash, { status: "success" });
    return hash;
  }
}

export interface CapturedLogEntry {
  level: "error" | "warn" | "info";
  fields: Record<string, unknown>;
  message: string;
}

export function makeCapturingLogger(): { logger: Logger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const at =
    (level: CapturedLogEntry["level"]) =>
    (fields: Record<string, unknown>, message: string): void => {
      entries.push({ level, fields, message });
    };
  const logger = { error: at("error"), warn: at("warn"), info: at("info") } as unknown as Logger;
  return { logger, entries };
}

type RepositoryMethod =
  | "createEscrowMintIntent"
  | "restartEscrowMintAttempt"
  | "recordEscrowMintSent"
  | "recordEscrowMintedPosition";

/**
 * In-memory SettlementRepository that enforces the same rules the database
 * does for the escrow-mint tables (one intent per piv+account, compare-and-set
 * attempts, one position per intent, the recorded flip and the position
 * written together), so the service is exercised against the real contract of
 * the repository. A real database run of the same rules is in
 * settlement-repository.integration.test.ts.
 *
 * failNext(method, "before") makes the next call throw without effect (the
 * process died before the write); failNext(method, "after") applies the write
 * and then throws (it committed but the caller never found out).
 */
export class InMemorySettlementRepository implements SettlementRepository {
  public readonly intents = new Map<string, EscrowMintIntent>();
  public readonly positions: Array<{ id: string; input: RecordEscrowMintedPositionInput }> = [];
  private readonly walletToAccount: Map<string, string>;
  private readonly failures: Array<{ method: RepositoryMethod; when: "before" | "after" }> = [];
  private readonly interleavings: Array<{ method: RepositoryMethod; action: () => void }> = [];
  private readonly intentReadInterleavings: Array<() => void | Promise<void>> = [];
  private idCounter = 0;

  public constructor(
    private readonly candidates: PivPendingEscrowResolution[],
    walletToAccount: Record<string, string>,
    private readonly timeline: string[] = [],
    legacyPositions: Array<{ pivId: string; accountId: string }> = [],
  ) {
    this.walletToAccount = new Map(Object.entries(walletToAccount));
    for (const legacy of legacyPositions) {
      this.positions.push({
        id: `position_legacy_${++this.idCounter}`,
        input: { pivId: legacy.pivId, accountId: legacy.accountId } as RecordEscrowMintedPositionInput,
      });
    }
  }

  public get recordedPositions(): RecordEscrowMintedPositionInput[] {
    return this.positions.map((position) => position.input).filter((input) => input.escrowMintIntentId !== undefined);
  }

  public failNext(method: RepositoryMethod, when: "before" | "after" = "before"): void {
    this.failures.push({ method, when });
  }

  /** Runs `action` just before the next `method` call applies -- another run slipping in first. */
  public interleaveBefore(method: RepositoryMethod, action: () => void): void {
    this.interleavings.push({ method, action });
  }

  /**
   * Runs `action` just before the next findEscrowMintIntent read -- another run committing
   * after this run's earlier reads (hasPosition) and before this one. The read is not on the
   * timeline, so ordering assertions over the write methods are unaffected.
   */
  public interleaveBeforeIntentRead(action: () => void | Promise<void>): void {
    this.intentReadInterleavings.push(action);
  }

  /** Writes an intent as another run would have, without going through a failure hook. */
  public seedIntent(intent: Partial<EscrowMintIntent> & Pick<EscrowMintIntent, "pivId" | "accountId">): EscrowMintIntent {
    const full: EscrowMintIntent = {
      id: `escrow_mint_seed_${++this.idCounter}`,
      walletAddress: "0xInvestorA",
      tokenContractAddress: PROPERTY_CONTRACT,
      tokenId: "1",
      mintAmount: 100n,
      status: "sending",
      mintTxHash: null,
      attempt: 1,
      attemptedAt: new Date(0),
      searchFromBlock: 0n,
      ...intent,
    };
    this.intents.set(full.id, full);
    return full;
  }

  public async findPivsWithPassedIpoDeadline(): Promise<PivPendingEscrowResolution[]> {
    return this.candidates;
  }

  public async resolveAccountIdForWallet(walletAddress: string): Promise<string | null> {
    return this.walletToAccount.get(walletAddress) ?? null;
  }

  public async hasPosition(pivId: string, accountId: string): Promise<boolean> {
    return this.positions.some((p) => p.input.pivId === pivId && p.input.accountId === accountId);
  }

  public async findEscrowMintIntent(pivId: string, accountId: string): Promise<EscrowMintIntent | null> {
    await this.intentReadInterleavings.shift()?.();
    const found = [...this.intents.values()].find((i) => i.pivId === pivId && i.accountId === accountId);
    return found === undefined ? null : { ...found };
  }

  public async createEscrowMintIntent(
    input: CreateEscrowMintIntentInput,
  ): Promise<{ intent: EscrowMintIntent; created: boolean }> {
    return this.run("createEscrowMintIntent", () => {
      const existing = [...this.intents.values()].find(
        (i) => i.pivId === input.pivId && i.accountId === input.accountId,
      );
      if (existing !== undefined) return { intent: { ...existing }, created: false };
      const intent: EscrowMintIntent = {
        id: `escrow_mint_${++this.idCounter}`,
        pivId: input.pivId,
        accountId: input.accountId,
        walletAddress: input.walletAddress,
        tokenContractAddress: input.tokenContractAddress,
        tokenId: input.tokenId,
        mintAmount: input.mintAmount,
        status: "sending",
        mintTxHash: null,
        attempt: 1,
        attemptedAt: input.attemptedAt,
        searchFromBlock: input.searchFromBlock,
      };
      this.intents.set(intent.id, intent);
      return { intent: { ...intent }, created: true };
    });
  }

  public async restartEscrowMintAttempt(input: {
    intentId: string;
    expectedAttempt: number;
    attemptedAt: Date;
  }): Promise<boolean> {
    return this.run("restartEscrowMintAttempt", () => {
      const intent = this.intents.get(input.intentId);
      if (intent === undefined || intent.attempt !== input.expectedAttempt || intent.status === "recorded") {
        return false;
      }
      intent.status = "sending";
      intent.mintTxHash = null;
      intent.attempt += 1;
      intent.attemptedAt = input.attemptedAt;
      return true;
    });
  }

  public async recordEscrowMintSent(input: { intentId: string; attempt: number; txHash: string }): Promise<void> {
    await this.run("recordEscrowMintSent", () => {
      const intent = this.intents.get(input.intentId);
      if (intent !== undefined && intent.attempt === input.attempt && intent.status === "sending") {
        intent.status = "mint_sent";
        intent.mintTxHash = input.txHash;
        return;
      }
      if (intent !== undefined && intent.attempt === input.attempt && intent.mintTxHash === input.txHash) return;
      throw new Error(`intent ${input.intentId} is not at attempt ${input.attempt} in 'sending'`);
    });
  }

  public async recordEscrowMintedPosition(
    input: RecordEscrowMintedPositionInput,
  ): Promise<{ positionId: string }> {
    return this.run("recordEscrowMintedPosition", () => {
      const intent = this.intents.get(input.escrowMintIntentId);
      if (intent === undefined || intent.status !== "mint_sent" || intent.mintTxHash !== input.chainTxHash) {
        const existing = this.positions.find((p) => p.input.escrowMintIntentId === input.escrowMintIntentId);
        if (existing !== undefined) return { positionId: existing.id };
        throw new Error(`intent ${input.escrowMintIntentId} is not in 'mint_sent' with tx ${input.chainTxHash}`);
      }
      // The flip and the position are one atomic step, as in the real transaction.
      intent.status = "recorded";
      const id = `position_${++this.idCounter}`;
      this.positions.push({ id, input });
      return { positionId: id };
    });
  }

  // Unused by the escrow-mint suites -- AD-241's wallet-registration
  // confirmation is covered by confirm-wallet-registrations.service.test.ts.
  public async countPendingWalletRegistrationsBefore(): Promise<number> {
    return 0;
  }

  public async findPendingWalletRegistrationByCommitment(): Promise<null> {
    return null;
  }

  public async confirmWalletRegistration(): Promise<void> {}

  public async getLastProcessedWalletRegistryBlock(): Promise<bigint | null> {
    return null;
  }

  public async setLastProcessedWalletRegistryBlock(): Promise<void> {}

  public async recordWalletRegistrationAddressMismatch(): Promise<void> {}

  private async run<T>(method: RepositoryMethod, body: () => T): Promise<T> {
    this.timeline.push(`repo:${method}`);
    const interleaving = this.interleavings.findIndex((entry) => entry.method === method);
    if (interleaving !== -1) this.interleavings.splice(interleaving, 1)[0]?.action();
    const index = this.failures.findIndex((failure) => failure.method === method);
    const failure = index === -1 ? undefined : this.failures.splice(index, 1)[0];
    if (failure?.when === "before") throw new Error(`process died before ${method}`);
    const result = body();
    if (failure?.when === "after") throw new Error(`process died after ${method} committed`);
    return result;
  }
}

/** One successful campaign with the given contributions, the common starting point. */
export function successfulCampaign(options: {
  tokenId: string;
  contributions: Record<string, bigint>;
  swept?: boolean;
}): {
  campaigns: Map<string, FakeCampaign>;
  contributions: Map<string, Map<string, bigint>>;
  contributors: Map<string, string[]>;
} {
  const total = Object.values(options.contributions).reduce((sum, value) => sum + value, 0n);
  return {
    campaigns: new Map([
      [
        options.tokenId,
        {
          targetAmount: total,
          totalRaised: total,
          deadline: 1n,
          treasury: "0xTREASURY",
          state: CAMPAIGN_STATE_SUCCESSFUL,
          swept: options.swept ?? false,
        },
      ],
    ]),
    contributions: new Map([[options.tokenId, new Map(Object.entries(options.contributions))]]),
    contributors: new Map([[options.tokenId, Object.keys(options.contributions)]]),
  };
}

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createPrismaClient, type DatabaseClient } from "../src/infrastructure/database/prisma.js";
import {
  ConfirmWalletRegistrationsService,
  type ConfirmWalletRegistrationsSummary,
  type WalletRegistrationEvidenceReader,
} from "../src/modules/settlement/application/confirm-wallet-registrations.service.js";
import { PrismaSettlementRepository } from "../src/modules/settlement/repository/prisma-settlement.repository.js";
import type { WalletRegistrationRecheckCandidate } from "../src/modules/settlement/repository/settlement.repository.js";
import { WalletRegistrationFixtures } from "./support/wallet-registration-db.js";

// The watcher against the real settlement repository and PostgreSQL, with a
// scripted chain: what the unit suite can only show through its in-memory fake
// (a flagged row refreshed and cleared, a bundle that settles over several runs)
// is shown here with the real compare-and-set, the real unique index and the
// real audit rows.

const databaseUrl = process.env.TEST_DATABASE_URL;

const hex = (byte: string) => `0x${byte.repeat(32)}`;
const UNKNOWN_BLOCK_HASH = hex("ee");

interface ScriptedLog {
  transactionHash: string;
  blockNumber: bigint;
  blockHash: string;
  logIndex: number;
  wallet: string;
  commitment: string;
}

class ScriptedChain {
  public head: bigint;
  public logs: ScriptedLog[] = [];

  public constructor(head: bigint) {
    this.head = head;
  }

  public client() {
    return {
      publicClient: { getBlockNumber: async () => this.head },
      walletRegistry: {
        address: `0x${"e".repeat(40)}`,
        getEvents: {
          WalletRegistered: async (_filter: unknown, range: { fromBlock: bigint; toBlock: bigint }) =>
            this.logs
              .filter((log) => log.blockNumber >= range.fromBlock && log.blockNumber <= range.toBlock)
              .map((log) => ({
                args: { wallet: log.wallet, commitment: log.commitment },
                transactionHash: log.transactionHash,
                blockHash: log.blockHash,
                blockNumber: log.blockNumber,
                logIndex: log.logIndex,
                removed: false,
              })),
        },
      },
    } as never;
  }

  public reader(): WalletRegistrationEvidenceReader {
    return {
      getCanonicalBlockHash: async (blockNumber) =>
        this.logs.find((log) => log.blockNumber === blockNumber)?.blockHash ?? UNKNOWN_BLOCK_HASH,
      findRegistrationEvent: async (input) => {
        const inTransaction = this.logs.filter((log) => log.transactionHash === input.transactionHash);
        if (inTransaction.length === 0) return { kind: "transaction_not_found" };
        const log = inTransaction.find(
          (candidate) =>
            candidate.wallet.toLowerCase() === input.walletAddress.toLowerCase() &&
            candidate.commitment.toLowerCase() === input.commitment.toLowerCase(),
        );
        if (log === undefined) return { kind: "event_not_found" };
        return {
          kind: "found",
          evidence: {
            transactionHash: log.transactionHash,
            blockHash: log.blockHash,
            blockNumber: log.blockNumber,
            logIndex: log.logIndex,
          },
          chainTimestamp: new Date(),
        };
      },
    };
  }
}

/**
 * The real repository, except for two things other suites on the same database
 * must not feel: the re-check lists only this suite's rows (it would otherwise
 * flag every other suite's confirmation, whose blocks this chain does not
 * know), and the cursor is kept in memory instead of in the shared setting.
 */
class ScopedSettlementRepository extends PrismaSettlementRepository {
  public cursor: bigint | null = null;
  public readonly accountIds = new Set<string>();

  public constructor(database: DatabaseClient) {
    super(database);
  }

  public override async listWalletRegistrationsForEvidenceRecheck(limit: number): Promise<WalletRegistrationRecheckCandidate[]> {
    const all = await super.listWalletRegistrationsForEvidenceRecheck(10_000);
    return all.filter((candidate) => this.accountIds.has(candidate.accountId)).slice(0, limit);
  }

  public override async getLastProcessedWalletRegistryBlock(): Promise<bigint | null> {
    return this.cursor;
  }

  public override async setLastProcessedWalletRegistryBlock(block: bigint): Promise<void> {
    this.cursor = block;
  }
}

describe.skipIf(databaseUrl === undefined)("ConfirmWalletRegistrationsService with the real settlement repository (PostgreSQL)", () => {
  const database = createPrismaClient(databaseUrl ?? "");
  const settlement = new ScopedSettlementRepository(database);
  const fixtures = new WalletRegistrationFixtures(database, databaseUrl ?? "");
  let counter = 0;

  afterAll(async () => {
    await fixtures.cleanup();
    await database.$disconnect();
  });

  // A test's re-check sees only the rows that test created.
  beforeEach(() => {
    settlement.accountIds.clear();
  });

  // Lower-case hex-looking values: the chain returns them as they are stored.
  async function registrations(count: number) {
    counter += 1;
    const accounts = [];
    for (let index = 0; index < count; index += 1) {
      const tag = `${fixtures.suffix}${counter}${index}`;
      const account = await fixtures.createRegistration({ walletAddress: `0xd${tag}`, commitment: `0xcd${tag}` });
      settlement.accountIds.add(account.accountId);
      accounts.push(account);
    }
    return accounts;
  }

  const read = (accountId: string) => database.walletRegistration.findUniqueOrThrow({ where: { accountId } });

  function runner(chain: ScriptedChain, cursor: bigint) {
    settlement.cursor = cursor;
    const service = new ConfirmWalletRegistrationsService(settlement, chain.client(), () => new Date(), undefined, chain.reader());
    // One run a minute, 30 blocks a minute.
    return async () => {
      const summary = await service.execute();
      chain.head += 30n;
      return summary;
    };
  }

  it("refreshes a flagged row when its event is on the chain again, clears the flag and keeps the old flag in the audit row", async () => {
    const [account] = await registrations(1);
    const transactionHash = fixtures.uniqueHash("flagged-comes-back");
    const log: ScriptedLog = {
      transactionHash,
      blockNumber: 500n,
      blockHash: hex("a0"),
      logIndex: 3,
      wallet: account!.walletAddress,
      commitment: account!.commitment,
    };
    const chain = new ScriptedChain(503n);
    chain.logs = [log];
    const run = runner(chain, 495n);

    const confirmed = await run();
    expect(confirmed.registrationsConfirmed).toBe(1);

    // The block is replaced and the transaction is missing for a run: flagged, the cursor goes back.
    chain.logs = [];
    const flagged = await run();
    expect(flagged).toMatchObject({ evidenceFlagged: 1, cursorRewoundTo: "499" });
    expect(await read(account!.accountId)).toMatchObject({ registrationEvidenceFlag: "transaction_missing" });

    // The same block is canonical again: the rewound cursor reads the event once more.
    chain.logs = [log];
    const back = await run();

    expect(back).toMatchObject({ evidenceRefreshed: 1, eventsReplayed: 0, conflictingEvents: 0 });
    expect(await read(account!.accountId)).toMatchObject({
      registrationTxHash: transactionHash,
      registrationBlockHash: hex("a0"),
      registrationLogIndex: 3,
      registrationEvidenceFlag: null,
      registrationEvidenceFlaggedAt: null,
      registrationEvidenceVerifiedAt: null,
    });
    expect(await fixtures.auditActions(account!.accountId)).toEqual([
      "settlement.wallet_registration_evidence_flagged",
      "settlement.wallet_registration_evidence_refreshed",
    ]);
    const refreshed = await database.auditLog.findFirstOrThrow({
      where: { resourceId: account!.accountId, action: "settlement.wallet_registration_evidence_refreshed" },
    });
    expect(refreshed.changes).toMatchObject({ previous_flag: "transaction_missing" });

    // And it is a normal confirmation again: nothing more to flag or refresh.
    expect(await run()).toMatchObject({ evidenceFlagged: 0, evidenceRefreshed: 0, conflictingEvents: 0, cursorRewoundTo: null });
    expect((await read(account!.accountId)).registrationEvidenceFlag).toBeNull();
  });

  describe("four registrations of one transaction, mined again with every log index shifted by two", () => {
    // Indexes 3, 5, 7, 9 become 5, 7, 9, 11: each row's new identity is the
    // next row's old one, so only the last row can move in the first run.
    async function scenario(flagFirst: boolean) {
      const accounts = await registrations(4);
      const transactionHash = fixtures.uniqueHash(`bundle-${flagFirst}`);
      const minedAt = (blockNumber: bigint, blockHash: string, firstIndex: number): ScriptedLog[] =>
        accounts.map((account, index) => ({
          transactionHash,
          blockNumber,
          blockHash,
          logIndex: firstIndex + index * 2,
          wallet: account.walletAddress,
          commitment: account.commitment,
        }));
      const chain = new ScriptedChain(503n);
      chain.logs = minedAt(500n, hex("a0"), 3);
      const run = runner(chain, 495n);

      expect((await run()).registrationsConfirmed).toBe(4);
      if (flagFirst) {
        // The transaction is gone for two runs: all four rows are flagged.
        chain.logs = [];
        expect(await run()).toMatchObject({ evidenceFlagged: 4, cursorRewoundTo: "499" });
        await run();
      }
      // Mined again six blocks below the head, in another block.
      chain.logs = minedAt(chain.head - 6n, hex("a1"), 5);

      const summaries: ConfirmWalletRegistrationsSummary[] = [];
      for (let index = 0; index < 8; index += 1) summaries.push(await run());
      const rows = await Promise.all(accounts.map((account) => read(account.accountId)));
      return { accounts, rows, summaries, chain };
    }

    it("settles flagged rows over the next runs, clears their flags and then stops rewinding", async () => {
      const { accounts, rows, summaries } = await scenario(true);

      expect(rows.map((row) => row.registrationLogIndex)).toEqual([5, 7, 9, 11]);
      for (const row of rows) {
        expect(row).toMatchObject({ registrationBlockHash: hex("a1"), registrationEvidenceFlag: null, registrationEvidenceFlaggedAt: null });
        expect(row.registeredAt).not.toBeNull();
      }
      // The row at the end of the chain of collisions moves first; each run's rewind brings the next one.
      expect(summaries.map((summary) => summary.evidenceRefreshed).slice(0, 5)).toEqual([1, 1, 1, 1, 0]);
      expect(summaries.map((summary) => summary.evidenceRefreshDeferred).slice(0, 5)).toEqual([3, 2, 1, 0, 0]);
      expect(summaries.slice(0, 3).map((summary) => summary.cursorRewoundTo)).toEqual([expect.any(String), expect.any(String), expect.any(String)]);
      expect(summaries.slice(3).map((summary) => summary.cursorRewoundTo)).toEqual([null, null, null, null, null]);
      const refreshAudits = await database.auditLog.count({
        where: { resourceId: { in: accounts.map((account) => account.accountId) }, action: "settlement.wallet_registration_evidence_refreshed" },
      });
      expect(refreshAudits).toBe(4);
    });

    it("settles rows that were never flagged the same way", async () => {
      const { rows, summaries } = await scenario(false);

      expect(rows.map((row) => row.registrationLogIndex)).toEqual([5, 7, 9, 11]);
      for (const row of rows) expect(row).toMatchObject({ registrationBlockHash: hex("a1"), registrationEvidenceFlag: null });
      expect(summaries.at(-1)).toMatchObject({ evidenceRefreshDeferred: 0, cursorRewoundTo: null });
    });
  });
});

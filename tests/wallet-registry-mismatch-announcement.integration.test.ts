import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { ConfirmWalletRegistrationsService } from "../src/modules/settlement/application/confirm-wallet-registrations.service.js";
import { RunWalletRegistryWatcherService } from "../src/modules/settlement/application/run-wallet-registry-watcher.service.js";
import { WalletRegistryAlertReporter } from "../src/modules/settlement/application/wallet-registry-alert-reporter.js";
import { PrismaSettlementRepository } from "../src/modules/settlement/repository/prisma-settlement.repository.js";
import type { WalletRegistryHeartbeat } from "../src/modules/settlement/repository/wallet-registry-health.repository.js";
import { WorkerMetrics } from "../src/shared/health/worker-metrics.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MISMATCH_ACTION = "settlement.wallet_registration_address_mismatch";

// The mismatch claim is an audit_log row committed on its own, so it outlives a
// run that fails afterwards. This runs the real repository, service, runner and
// reporter against PostgreSQL to show that the signal is still announced, once,
// when a later event in the same run throws, and not again on the retry.
//
// Two pieces of state are shared with other test files, because each is one
// platform.settings row in a database they all use in parallel: the watcher's
// cursor, and the watcher heartbeat (whose only owner among the integration
// tests is wallet-registry-health.integration.test.ts, which deletes it and
// asserts on it; tests/wallet-registry-heartbeat-isolation.test.ts keeps it so).
// Both are held in memory here. Everything else is the real repository on rows
// only this file creates.
describe.skipIf(databaseUrl === undefined)("address mismatch announcement against PostgreSQL", () => {
  const suffix = randomUUID().replace(/-/g, "");
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");

  const address = () => `0x${randomBytes(20).toString("hex")}`;
  const commitment = () => `0x${randomBytes(32).toString("hex")}`;
  const storedWalletA = address();
  const attackerWallet = address();
  const walletB = address();
  const commitmentA = commitment();
  const commitmentB = commitment();
  const accountA = `account_wmis_a_${suffix}`;
  const accountB = `account_wmis_b_${suffix}`;

  class IsolatedCursorRepository extends PrismaSettlementRepository {
    public cursor: bigint | null = 10n;
    public failConfirmOnce = true;

    public override async getLastProcessedWalletRegistryBlock(): Promise<bigint | null> {
      return this.cursor;
    }

    public override async setLastProcessedWalletRegistryBlock(block: bigint): Promise<void> {
      this.cursor = block;
    }

    public override async confirmWalletRegistration(accountId: string, confirmedAt: Date): Promise<void> {
      if (this.failConfirmOnce && accountId === accountB) {
        this.failConfirmOnce = false;
        throw new Error("database blip");
      }
      await super.confirmWalletRegistration(accountId, confirmedAt);
    }
  }

  async function createAccount(accountId: string, walletAddress: string, registrationCommitment: string): Promise<void> {
    const betterAuthUserId = `auth_${accountId}`;
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Wallet Mismatch Test", `${accountId}@example.test`, true, "customer"],
    );
    await database.account.create({ data: { id: accountId, betterAuthUserId } });
    await database.walletRegistration.create({
      data: { accountId, walletAddress, registrationCommitment, requestedAt: new Date() },
    });
  }

  beforeAll(async () => {
    await createAccount(accountA, storedWalletA, commitmentA);
    await createAccount(accountB, walletB, commitmentB);
  });

  afterAll(async () => {
    const accountIds = [accountA, accountB];
    await database.auditLog.deleteMany({ where: { resourceType: "wallet_registration", resourceId: { in: accountIds } } });
    await database.walletRegistration.deleteMany({ where: { accountId: { in: accountIds } } });
    await database.account.deleteMany({ where: { id: { in: accountIds } } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = ANY($1)', [accountIds.map((id) => `auth_${id}`)]);
    await authPool.end();
    await database.$disconnect();
  });

  it("announces the first-seen mismatch once although the run fails after its claim, and not again on the retry", async () => {
    const repository = new IsolatedCursorRepository(database);
    // Block 15: a registration for account A sent from the wrong address. Block
    // 16: account B's legitimate registration, whose confirm fails once.
    const chain = {
      publicClient: { getBlockNumber: async () => 20n },
      walletRegistry: {
        getEvents: {
          WalletRegistered: vi.fn(async () => [
            { args: { wallet: attackerWallet, commitment: commitmentA }, blockNumber: 15n },
            { args: { wallet: walletB, commitment: commitmentB }, blockNumber: 16n },
          ]),
        },
      },
    };
    const logged: Array<{ level: string; fields: Record<string, unknown> }> = [];
    const heartbeats: WalletRegistryHeartbeat[] = [];
    const at = (level: string) => (fields: Record<string, unknown>) => void logged.push({ level, fields });
    const metrics = new WorkerMetrics();
    const reporter = new WalletRegistryAlertReporter({
      logger: { info: at("info"), warn: at("warn"), error: at("error") } as never,
      metrics,
      heartbeats: { recordWatcherHeartbeat: async (input) => void heartbeats.push(input) },
      thresholds: {
        watcherStaleAfterMs: 600_000,
        cursorLagAlertBlocks: 900n,
        cursorAheadToleranceBlocks: 32n,
        pendingOverdueAlertCount: 1_000_000,
        unmatchedEventsAlertCount: 1_000_000,
      },
      jobs: { watcher: "settlement.confirm_wallet_registrations", health: "settlement.check_wallet_registry_health" },
    });
    const runner = new RunWalletRegistryWatcherService(
      new ConfirmWalletRegistrationsService(repository, chain as never),
      repository,
      reporter,
      () => "req_integration",
    );
    const announcedFor = (accountId: string) =>
      logged.filter((line) => line.fields.event === "wallet_registry.address_mismatch" && line.fields.account_id === accountId);
    const auditRowsFor = (accountId: string) =>
      database.auditLog.count({ where: { action: MISMATCH_ACTION, resourceType: "wallet_registration", resourceId: accountId } });

    await expect(runner.execute()).rejects.toThrow("database blip");

    // A run that throws is not a completed run: no heartbeat for it.
    expect(heartbeats).toHaveLength(0);

    expect(await auditRowsFor(accountA)).toBe(1);
    expect(announcedFor(accountA)).toHaveLength(1);
    expect(announcedFor(accountA)[0]).toMatchObject({ level: "error", fields: { severity: "error", trace_id: "req_integration" } });

    // The retry reads both events again: the claim exists, so A is a repeat; B confirms.
    await runner.execute();

    // The retry completed, and its heartbeat went to the writer above, not to the shared row.
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({ cursorBlock: 17n, safeHeadBlock: 17n, eventsFound: 2 });
    expect(await auditRowsFor(accountA)).toBe(1);
    expect(announcedFor(accountA)).toHaveLength(1);
    const confirmed = await database.walletRegistration.findUnique({ where: { accountId: accountB } });
    expect(confirmed?.registeredAt).not.toBeNull();
    expect(metrics.render()).toContain("vistablox_worker_wallet_registration_address_mismatches_total 1");
    expect(metrics.render()).toContain("vistablox_worker_wallet_registration_address_mismatch_duplicates_total 1");
    // And no full value reached the log.
    const everything = JSON.stringify(logged).toLowerCase();
    for (const full of [storedWalletA, attackerWallet, commitmentA]) expect(everything).not.toContain(full.toLowerCase());
  });
});

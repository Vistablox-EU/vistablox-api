import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "../src/generated/prisma/client.js";
import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { CheckWalletRegistryHealthService } from "../src/modules/settlement/application/check-wallet-registry-health.service.js";
import { RunWalletRegistryWatcherService } from "../src/modules/settlement/application/run-wallet-registry-watcher.service.js";
import { WalletRegistryAlertReporter } from "../src/modules/settlement/application/wallet-registry-alert-reporter.js";
import { WorkerMetrics } from "../src/shared/health/worker-metrics.js";
import { PrismaWalletRegistryHealthRepository } from "../src/modules/settlement/repository/prisma-wallet-registry-health.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const HEARTBEAT_KEY = "wallet_registry.watcher_heartbeat";
const MISMATCH_ACTION = "settlement.wallet_registration_address_mismatch";

// Other test files share this database and run in parallel, so nothing here
// asserts a global count exactly: pending claims are far in the past (1990) so
// the oldest one and the overdue delta are deterministic, and unresolved
// mismatches are asserted by account-id membership, with audit rows dated 1990
// so they sort ahead of anything else in the 20-account listing.
describe.skipIf(databaseUrl === undefined)("PrismaWalletRegistryHealthRepository PostgreSQL integration", () => {
  const suffix = randomUUID().replace(/-/g, "");
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const repository = new PrismaWalletRegistryHealthRepository(database);

  const hex = (tag: string, length: number) => `0x${(tag + suffix).padEnd(length, "0").slice(0, length)}`;
  const accounts = new Map<string, string>();
  const accountIdOf = (name: string): string => {
    const id = accounts.get(name);
    if (id === undefined) throw new Error(`no fixture account ${name}`);
    return id;
  };

  async function createAccount(
    name: string,
    claim: { commitment: string; requestedAt: Date; registeredAt: Date | null },
  ): Promise<string> {
    const accountId = `account_whealth_${name}_${suffix}`;
    const betterAuthUserId = `auth_whealth_${name}_${suffix}`;
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Wallet Health Test", `whealth-${name}-${suffix}@example.test`, true, "customer"],
    );
    await database.account.create({ data: { id: accountId, betterAuthUserId } });
    await database.walletRegistration.create({
      data: {
        accountId,
        walletAddress: hex(`a${accounts.size}`, 42),
        registrationCommitment: claim.commitment,
        requestedAt: claim.requestedAt,
        registeredAt: claim.registeredAt,
      },
    });
    accounts.set(name, accountId);
    return accountId;
  }

  let mismatchSeq = 0;
  async function recordMismatchRow(name: string, commitment: string, eventKey: string | null): Promise<void> {
    mismatchSeq += 1;
    await database.auditLog.create({
      data: {
        id: `audit_whealth_${suffix}_${mismatchSeq}`,
        ...(eventKey === null ? {} : { eventKey }),
        action: MISMATCH_ACTION,
        resourceType: "wallet_registration",
        resourceId: accountIdOf(name),
        changes: { commitment, stored_wallet_address: hex("5", 42), onchain_sender: hex("6", 42) },
        createdAt: new Date(Date.UTC(1990, 0, 1, 0, 0, mismatchSeq)),
      },
    });
  }

  const longAgo = new Date("1990-01-01T00:00:00.000Z");
  const farFuture = new Date("2099-01-01T00:00:00.000Z");
  const commitment = (tag: string) => hex(tag, 66);

  beforeAll(async () => {
    // Pending, requested in 1990: overdue for any realistic cutoff.
    await createAccount("old1", { commitment: commitment("c1"), requestedAt: longAgo, registeredAt: null });
    await createAccount("old2", { commitment: commitment("c2"), requestedAt: longAgo, registeredAt: null });
    // Pending but requested in 2099: never overdue.
    await createAccount("fresh", { commitment: commitment("c3"), requestedAt: farFuture, registeredAt: null });
    // Already confirmed: neither pending nor an open mismatch.
    await createAccount("confirmed", {
      commitment: commitment("c4"),
      requestedAt: longAgo,
      registeredAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    // Mismatch cases.
    await createAccount("mismatchOpen", { commitment: commitment("d1"), requestedAt: farFuture, registeredAt: null });
    await createAccount("mismatchMixedCase", { commitment: commitment("d2"), requestedAt: farFuture, registeredAt: null });
    await createAccount("mismatchLegacy", { commitment: commitment("d3"), requestedAt: farFuture, registeredAt: null });
    await createAccount("mismatchReplaced", { commitment: commitment("d4-new"), requestedAt: farFuture, registeredAt: null });
    await createAccount("mismatchConfirmed", {
      commitment: commitment("d5"),
      requestedAt: longAgo,
      registeredAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await recordMismatchRow("mismatchOpen", commitment("d1"), `wallet_registration_address_mismatch:${suffix}:open`);
    // The audit row holds the commitment in another case than the claim.
    await recordMismatchRow("mismatchMixedCase", commitment("d2").toUpperCase().replace("0X", "0x"), `${suffix}:mixed`);
    // Written by main before event keys existed.
    await recordMismatchRow("mismatchLegacy", commitment("d3"), null);
    // The claim has since been replaced with another commitment.
    await recordMismatchRow("mismatchReplaced", commitment("d4-old"), `${suffix}:replaced`);
    // The claim was confirmed afterwards.
    await recordMismatchRow("mismatchConfirmed", commitment("d5"), `${suffix}:confirmed`);
  });

  afterAll(async () => {
    const accountIds = [...accounts.values()];
    await database.auditLog.deleteMany({ where: { resourceType: "wallet_registration", resourceId: { in: accountIds } } });
    await database.walletRegistration.deleteMany({ where: { accountId: { in: accountIds } } });
    await database.account.deleteMany({ where: { id: { in: accountIds } } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = ANY($1)', [
      [...accounts.keys()].map((name) => `auth_whealth_${name}_${suffix}`),
    ]);
    await database.platformSetting.deleteMany({ where: { key: HEARTBEAT_KEY } });
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  describe("pending claims", () => {
    it("counts unconfirmed claims and finds the oldest request", async () => {
      const reading = await repository.readWalletRegistryHealth(new Date("2000-01-01T00:00:00.000Z"));

      // Four unconfirmed fixtures from this file; others may add more.
      expect(reading.pendingTotal).toBeGreaterThanOrEqual(7);
      expect(reading.oldestPendingRequestedAt).toEqual(longAgo);
    });

    it("counts only claims requested before the cutoff as overdue", async () => {
      const before1990 = await repository.readWalletRegistryHealth(new Date("1989-01-01T00:00:00.000Z"));
      const after1990 = await repository.readWalletRegistryHealth(new Date("2000-01-01T00:00:00.000Z"));
      const beyondFuture = await repository.readWalletRegistryHealth(new Date("2100-01-01T00:00:00.000Z"));

      // The two 1990 claims become overdue between those cutoffs; the confirmed
      // 1990 claim never counts.
      expect(after1990.pendingOverdue - before1990.pendingOverdue).toBe(2);
      // The 2099 claims are overdue only for a cutoff past 2099.
      expect(beyondFuture.pendingOverdue - after1990.pendingOverdue).toBeGreaterThanOrEqual(5);
      expect(beyondFuture.pendingOverdue).toBeLessThanOrEqual(beyondFuture.pendingTotal);
    });

    it("returns a Date and plain numbers, not bigints", async () => {
      const reading = await repository.readWalletRegistryHealth(new Date());

      expect(typeof reading.pendingTotal).toBe("number");
      expect(typeof reading.pendingOverdue).toBe("number");
      expect(reading.oldestPendingRequestedAt).toBeInstanceOf(Date);
    });
  });

  describe("unresolved address mismatches", () => {
    it("lists an account whose current claim still carries the mismatching commitment, whatever its case", async () => {
      const { unresolvedMismatches } = await repository.readWalletRegistryHealth(new Date());

      expect(unresolvedMismatches.accountIds).toContain(accountIdOf("mismatchOpen"));
      expect(unresolvedMismatches.accountIds).toContain(accountIdOf("mismatchMixedCase"));
    });

    it("counts a legacy mismatch row that has no event key", async () => {
      const { unresolvedMismatches } = await repository.readWalletRegistryHealth(new Date());

      expect(unresolvedMismatches.accountIds).toContain(accountIdOf("mismatchLegacy"));
    });

    it("drops an account once its claim was confirmed or replaced by another commitment", async () => {
      const { unresolvedMismatches } = await repository.readWalletRegistryHealth(new Date());

      expect(unresolvedMismatches.accountIds).not.toContain(accountIdOf("mismatchConfirmed"));
      expect(unresolvedMismatches.accountIds).not.toContain(accountIdOf("mismatchReplaced"));
    });

    it("reports an account once however many mismatch rows it has, with a total that covers the listing", async () => {
      await recordMismatchRow("mismatchOpen", commitment("d1"), `${suffix}:open-second-sender`);

      const { unresolvedMismatches } = await repository.readWalletRegistryHealth(new Date());

      expect(unresolvedMismatches.accountIds.filter((id) => id === accountIdOf("mismatchOpen"))).toHaveLength(1);
      expect(unresolvedMismatches.count).toBeGreaterThanOrEqual(3);
      expect(unresolvedMismatches.accountIds.length).toBeLessThanOrEqual(20);
      expect(unresolvedMismatches.accountIds.length).toBeLessThanOrEqual(unresolvedMismatches.count);
    });

    it("drops an account when its claim is confirmed", async () => {
      await database.walletRegistration.update({
        where: { accountId: accountIdOf("mismatchLegacy") },
        data: { registeredAt: new Date("2026-11-13T00:00:00.000Z") },
      });

      const { unresolvedMismatches } = await repository.readWalletRegistryHealth(new Date());

      expect(unresolvedMismatches.accountIds).not.toContain(accountIdOf("mismatchLegacy"));
    });
  });

  describe("watcher heartbeat", () => {
    const completedAt = new Date("2026-11-13T12:00:00.000Z");

    it("reads as missing before any run has completed", async () => {
      await database.platformSetting.deleteMany({ where: { key: HEARTBEAT_KEY } });

      expect((await repository.readWalletRegistryHealth(new Date())).heartbeat).toBeNull();
    });

    it("round-trips what a run wrote, bigints included", async () => {
      await repository.recordWatcherHeartbeat({
        completedAt,
        cursorBlock: 12_345_678_901n,
        safeHeadBlock: 12_345_678_950n,
        eventsFound: 3,
      });

      expect((await repository.readWalletRegistryHealth(new Date())).heartbeat).toEqual({
        completedAt,
        cursorBlock: 12_345_678_901n,
        safeHeadBlock: 12_345_678_950n,
        eventsFound: 3,
      });
    });

    it("stores a run that never saved a cursor as a null cursor", async () => {
      await repository.recordWatcherHeartbeat({ completedAt, cursorBlock: null, safeHeadBlock: 0n, eventsFound: 0 });

      expect((await repository.readWalletRegistryHealth(new Date())).heartbeat).toMatchObject({
        cursorBlock: null,
        safeHeadBlock: 0n,
      });
    });

    it("overwrites the previous heartbeat in place and moves updated_at with it", async () => {
      const later = new Date("2026-11-13T12:05:00.000Z");
      await repository.recordWatcherHeartbeat({ completedAt, cursorBlock: 1n, safeHeadBlock: 2n, eventsFound: 0 });
      await repository.recordWatcherHeartbeat({ completedAt: later, cursorBlock: 3n, safeHeadBlock: 4n, eventsFound: 1 });

      const row = await database.platformSetting.findUnique({ where: { key: HEARTBEAT_KEY } });
      expect(row?.updatedAt).toEqual(later);
      expect((await repository.readWalletRegistryHealth(new Date())).heartbeat).toEqual({
        completedAt: later,
        cursorBlock: 3n,
        safeHeadBlock: 4n,
        eventsFound: 1,
      });
      expect(await database.platformSetting.count({ where: { key: HEARTBEAT_KEY } })).toBe(1);
    });

    it("ignores fields a later build may add", async () => {
      await database.platformSetting.update({
        where: { key: HEARTBEAT_KEY },
        data: {
          value: {
            version: 2,
            completed_at: completedAt.toISOString(),
            cursor_block: "7",
            safe_head_block: "9",
            events_found: 0,
            something_new: { nested: true },
          },
        },
      });

      expect((await repository.readWalletRegistryHealth(new Date())).heartbeat).toMatchObject({
        cursorBlock: 7n,
        safeHeadBlock: 9n,
      });
    });

    it.each([
      ["a string", "garbage"],
      ["a missing field", { completed_at: completedAt.toISOString(), cursor_block: "1" }],
      ["a bad date", { completed_at: "yesterday", cursor_block: "1", safe_head_block: "2", events_found: 0 }],
      ["a non-numeric block", { completed_at: completedAt.toISOString(), cursor_block: "0xabc", safe_head_block: "2", events_found: 0 }],
      ["a negative event count", { completed_at: completedAt.toISOString(), cursor_block: "1", safe_head_block: "2", events_found: -1 }],
      ["null", null],
    ])("reads %s as no heartbeat instead of throwing", async (_label, value) => {
      await database.platformSetting.update({
        where: { key: HEARTBEAT_KEY },
        // A Json column only holds a JSON null through Prisma.JsonNull; the rest pass as they are.
        data: { value: value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue) },
      });

      expect((await repository.readWalletRegistryHealth(new Date())).heartbeat).toBeNull();
    });

    it("survives concurrent first-time and repeated writes", async () => {
      await database.platformSetting.deleteMany({ where: { key: HEARTBEAT_KEY } });

      await expect(
        Promise.all(
          Array.from({ length: 4 }, (_unused, index) =>
            repository.recordWatcherHeartbeat({
              completedAt,
              cursorBlock: BigInt(index),
              safeHeadBlock: 100n,
              eventsFound: index,
            }),
          ),
        ),
      ).resolves.toHaveLength(4);

      expect(await database.platformSetting.count({ where: { key: HEARTBEAT_KEY } })).toBe(1);
      expect((await repository.readWalletRegistryHealth(new Date())).heartbeat?.safeHeadBlock).toBe(100n);
    });
  });

  // The two jobs as the worker wires them: a completed watcher run writes the
  // heartbeat through the reporter into the real table, and the health check
  // reads it back and judges it.
  describe("watcher run followed by a health check", () => {
    const thresholds = {
      watcherStaleAfterMs: 600_000,
      cursorLagAlertBlocks: 900n,
      cursorAheadToleranceBlocks: 32n,
      // Other test files share this database, so claims pending there must not
      // decide the outcome here.
      pendingOverdueAlertCount: 1_000_000,
      unmatchedEventsAlertCount: 5,
    };

    function wire() {
      const logged: Array<{ level: string; fields: Record<string, unknown> }> = [];
      const at = (level: string) => (fields: Record<string, unknown>) => void logged.push({ level, fields });
      const reporter = new WalletRegistryAlertReporter({
        logger: { info: at("info"), warn: at("warn"), error: at("error") } as never,
        metrics: new WorkerMetrics(),
        heartbeats: repository,
        thresholds,
        jobs: { watcher: "settlement.confirm_wallet_registrations", health: "settlement.check_wallet_registry_health" },
      });
      const check = (clock?: () => Date) =>
        new CheckWalletRegistryHealthService(
          repository,
          reporter,
          {
            thresholds,
            watcherConfigured: true,
            workerStartedAt: new Date(Date.now() - 3_600_000),
            pendingOverdueAfterMs: 5 * 60_000,
            ...(clock === undefined ? {} : { clock }),
          },
          () => "req_integration",
        );
      return { reporter, logged, check };
    }

    it("reads a fresh heartbeat as a healthy watcher, and the same heartbeat as stalled once it ages", async () => {
      const { reporter, logged, check } = wire();
      const run = new RunWalletRegistryWatcherService(
        {
          execute: async () => ({
            fromBlock: "1",
            toBlock: "5000",
            safeHeadBlock: "5000",
            eventsFound: 2,
            registrationsConfirmed: 0,
            unmatchedEvents: 0,
            newUnmatchedEvents: 0,
            addressMismatches: [],
            addressMismatchesRepeated: 0,
            pendingRegistrationsOverdue: 0,
            pendingWarnAfterMinutes: 5,
          }),
        },
        { getLastProcessedWalletRegistryBlock: async () => 4990n },
        reporter,
        () => "req_integration",
      );

      await run.execute();
      await check().execute();

      const healthChecked = logged.find((entry) => entry.fields.event === "wallet_registry.health_checked");
      expect(healthChecked?.fields).toMatchObject({
        watcher_configured: true,
        cursor_block: "4990",
        safe_head_block: "5000",
        cursor_lag_blocks: "10",
      });
      expect(logged.filter((entry) => entry.fields.severity === "error")).toEqual([]);

      // The same row, judged an hour from now: no run since, so stalled.
      await check(() => new Date(Date.now() + 3_600_000)).execute();
      expect(logged.some((entry) => entry.fields.event === "wallet_registry.watcher_stalled")).toBe(true);
    });
  });
});

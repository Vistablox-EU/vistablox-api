import { describe, expect, it, vi } from "vitest";

import { CheckWalletRegistryHealthService } from "../src/modules/settlement/application/check-wallet-registry-health.service.js";
import { WalletRegistryAlertReporter } from "../src/modules/settlement/application/wallet-registry-alert-reporter.js";
import type { WalletRegistryAlertThresholds } from "../src/modules/settlement/domain/wallet-registry-alert-policy.js";
import type { WalletRegistryHealthReading } from "../src/modules/settlement/repository/wallet-registry-health.repository.js";
import { WorkerMetrics } from "../src/shared/health/worker-metrics.js";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const MINUTE = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const RPC_SECRET = "SECRETPROVIDERKEY123";

const THRESHOLDS: WalletRegistryAlertThresholds = {
  watcherStaleAfterMs: 10 * MINUTE,
  cursorLagAlertBlocks: 900n,
  cursorAheadToleranceBlocks: 32n,
  pendingOverdueAlertCount: 1,
  unmatchedEventsAlertCount: 5,
};

function healthyReading(overrides: Partial<WalletRegistryHealthReading> = {}): WalletRegistryHealthReading {
  return {
    heartbeat: { completedAt: ago(MINUTE), cursorBlock: 1000n, safeHeadBlock: 1005n, eventsFound: 0 },
    pendingTotal: 0,
    pendingOverdue: 0,
    oldestPendingRequestedAt: null,
    unresolvedMismatches: { count: 0, accountIds: [] },
    ...overrides,
  };
}

function setup(
  read: (cutoff: Date) => Promise<WalletRegistryHealthReading>,
  options: { watcherConfigured?: boolean; workerStartedAt?: Date } = {},
) {
  const logged: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
  const at = (level: string) =>
    vi.fn((fields: Record<string, unknown>, message: string) => void logged.push({ level, fields, message }));
  const metrics = new WorkerMetrics();
  const reporter = new WalletRegistryAlertReporter({
    logger: { info: at("info"), warn: at("warn"), error: at("error") } as never,
    metrics,
    heartbeats: { recordWatcherHeartbeat: async () => {} },
    thresholds: THRESHOLDS,
    jobs: { watcher: "settlement.confirm_wallet_registrations", health: "settlement.check_wallet_registry_health" },
    clock: () => NOW,
  });
  const reader = { readWalletRegistryHealth: vi.fn(read) };
  const service = new CheckWalletRegistryHealthService(
    reader,
    reporter,
    {
      thresholds: THRESHOLDS,
      watcherConfigured: options.watcherConfigured ?? true,
      workerStartedAt: options.workerStartedAt ?? ago(60 * MINUTE),
      pendingOverdueAfterMs: 5 * MINUTE,
      clock: () => NOW,
    },
    () => "req_health_1",
  );
  return { service, reader, logged, metrics };
}

const events = (logged: Array<{ fields: Record<string, unknown> }>) => logged.map((entry) => entry.fields.event);

describe("CheckWalletRegistryHealthService", () => {
  it("reports only proof of life for a healthy watcher", async () => {
    const { service, logged, metrics } = setup(async () => healthyReading());

    await service.execute();

    expect(events(logged)).toEqual(["wallet_registry.health_checked"]);
    expect(logged[0]).toMatchObject({ level: "info", fields: { severity: "info", trace_id: "req_health_1", alerts_active: 0 } });
    expect(metrics.render()).toContain("vistablox_worker_wallet_registration_health_alerts_active 0");
  });

  it("asks the reader for claims older than the pending threshold, measured from now", async () => {
    const { service, reader } = setup(async () => healthyReading());

    await service.execute();

    expect(reader.readWalletRegistryHealth).toHaveBeenCalledTimes(1);
    expect(reader.readWalletRegistryHealth.mock.calls[0]?.[0]).toEqual(ago(5 * MINUTE));
  });

  it("reports a stalled watcher as an error", async () => {
    const { service, logged } = setup(async () =>
      healthyReading({ heartbeat: { completedAt: ago(15 * MINUTE), cursorBlock: 1000n, safeHeadBlock: 1005n, eventsFound: 0 } }),
    );

    await service.execute();

    expect(logged.map((entry) => [entry.level, entry.fields.event])).toEqual([
      ["info", "wallet_registry.health_checked"],
      ["error", "wallet_registry.watcher_stalled"],
    ]);
  });

  it("reports a lagging cursor, overdue claims and an open mismatch together, with the account ids", async () => {
    const { service, logged } = setup(async () =>
      healthyReading({
        heartbeat: { completedAt: ago(MINUTE), cursorBlock: 100n, safeHeadBlock: 5000n, eventsFound: 0 },
        pendingTotal: 4,
        pendingOverdue: 3,
        oldestPendingRequestedAt: ago(60 * MINUTE),
        unresolvedMismatches: { count: 1, accountIds: ["acct_a"] },
      }),
    );

    await service.execute();

    expect(logged.map((entry) => [entry.level, entry.fields.event])).toEqual([
      ["info", "wallet_registry.health_checked"],
      ["error", "wallet_registry.cursor_lag"],
      ["warn", "wallet_registry.pending_overdue"],
      ["warn", "wallet_registry.address_mismatch_unresolved"],
    ]);
    expect(logged[3]?.fields).toMatchObject({ unresolved_count: 1, account_ids: ["acct_a"] });
  });

  it("raises watcher_not_configured, as an error once claims are waiting, when the watcher cannot run", async () => {
    const { service, logged } = setup(async () => healthyReading({ heartbeat: null, pendingTotal: 2 }), {
      watcherConfigured: false,
    });

    await service.execute();

    expect(logged.map((entry) => [entry.level, entry.fields.event])).toEqual([
      ["info", "wallet_registry.health_checked"],
      ["error", "wallet_registry.watcher_not_configured"],
    ]);
  });

  it("uses the worker's start so a fresh deploy is not called stalled", async () => {
    const { service, logged } = setup(async () => healthyReading({ heartbeat: null }), { workerStartedAt: ago(2 * MINUTE) });

    await service.execute();

    expect(events(logged)).toEqual(["wallet_registry.health_checked"]);
  });

  describe("when the check itself fails", () => {
    it("reports health_check_failed and rethrows a sanitised error", async () => {
      const { service, logged, metrics } = setup(async () => {
        throw new Error(`cannot reach https://db.example.org/${RPC_SECRET}`);
      });

      const thrown = await service.execute().then(
        () => undefined,
        (error: unknown) => error as Error,
      );

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown?.message).not.toContain(RPC_SECRET);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        level: "error",
        fields: { event: "wallet_registry.health_check_failed", severity: "error", trace_id: "req_health_1" },
      });
      expect(JSON.stringify(logged)).not.toContain(RPC_SECRET);
      expect(metrics.render()).toContain("vistablox_worker_wallet_registration_health_check_failures_total 1");
    });
  });
});

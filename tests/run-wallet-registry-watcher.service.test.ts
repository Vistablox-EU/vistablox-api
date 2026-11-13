import { HttpRequestError } from "viem";
import { describe, expect, it, vi } from "vitest";

import type {
  ConfirmWalletRegistrationsHooks,
  ConfirmWalletRegistrationsSummary,
} from "../src/modules/settlement/application/confirm-wallet-registrations.service.js";
import { RunWalletRegistryWatcherService } from "../src/modules/settlement/application/run-wallet-registry-watcher.service.js";
import { WalletRegistryAlertReporter } from "../src/modules/settlement/application/wallet-registry-alert-reporter.js";
import type { WalletRegistryHeartbeat } from "../src/modules/settlement/repository/wallet-registry-health.repository.js";
import { WorkerMetrics } from "../src/shared/health/worker-metrics.js";

const RPC_SECRET = "SECRETPROVIDERKEY123";
const RPC_URL = `https://base-sepolia.g.alchemy.com/v2/${RPC_SECRET}`;
const NOW = new Date("2026-11-13T12:00:00.000Z");

function summary(overrides: Partial<ConfirmWalletRegistrationsSummary> = {}): ConfirmWalletRegistrationsSummary {
  return {
    fromBlock: "69",
    toBlock: "117",
    safeHeadBlock: "117",
    eventsFound: 0,
    registrationsConfirmed: 0,
    unmatchedEvents: 0,
    newUnmatchedEvents: 0,
    addressMismatches: [],
    addressMismatchesRepeated: 0,
    pendingRegistrationsOverdue: 0,
    pendingWarnAfterMinutes: 5,
    ...overrides,
  };
}

function setup(
  confirm: (hooks?: ConfirmWalletRegistrationsHooks) => Promise<ConfirmWalletRegistrationsSummary>,
  cursor: () => Promise<bigint | null>,
) {
  const logged: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
  const at = (level: string) =>
    vi.fn((fields: Record<string, unknown>, message: string) => void logged.push({ level, fields, message }));
  const heartbeats: WalletRegistryHeartbeat[] = [];
  const metrics = new WorkerMetrics();
  const reporter = new WalletRegistryAlertReporter({
    logger: { info: at("info"), warn: at("warn"), error: at("error") } as never,
    metrics,
    heartbeats: { recordWatcherHeartbeat: async (input) => void heartbeats.push(input) },
    thresholds: {
      watcherStaleAfterMs: 600_000,
      cursorLagAlertBlocks: 900n,
      cursorAheadToleranceBlocks: 32n,
      pendingOverdueAlertCount: 1,
      unmatchedEventsAlertCount: 5,
    },
    jobs: { watcher: "settlement.confirm_wallet_registrations", health: "settlement.check_wallet_registry_health" },
    clock: () => NOW,
  });
  const service = new RunWalletRegistryWatcherService(
    { execute: confirm },
    { getLastProcessedWalletRegistryBlock: cursor },
    reporter,
    () => "req_run_1",
  );
  return { service, logged, heartbeats, metrics };
}

describe("RunWalletRegistryWatcherService", () => {
  it("writes the heartbeat with the cursor the repository holds and the run's safe head", async () => {
    const { service, heartbeats, logged, metrics } = setup(
      async () => summary({ safeHeadBlock: "117", eventsFound: 3 }),
      async () => 100n,
    );

    await service.execute();

    expect(heartbeats).toEqual([{ completedAt: NOW, safeHeadBlock: 117n, cursorBlock: 100n, eventsFound: 3 }]);
    expect(logged[0]).toMatchObject({ level: "info", message: "case timer job completed", fields: { trace_id: "req_run_1" } });
    expect(metrics.render()).toContain("vistablox_worker_wallet_registration_runs_total 1");
  });

  it("writes a heartbeat for an early-return run too, so alive-with-nothing-to-scan differs from dead", async () => {
    // What the watcher returns when its cursor is ahead of the safe head: no
    // events were read and the cursor was not moved, but the run completed.
    const { service, heartbeats } = setup(
      async () => summary({ fromBlock: "69", toBlock: "47", safeHeadBlock: "47" }),
      async () => 100n,
    );

    await service.execute();

    expect(heartbeats).toEqual([{ completedAt: NOW, safeHeadBlock: 47n, cursorBlock: 100n, eventsFound: 0 }]);
  });

  it("records a null cursor before the very first one is saved", async () => {
    const { service, heartbeats } = setup(async () => summary({ safeHeadBlock: "0" }), async () => null);

    await service.execute();

    expect(heartbeats[0]).toMatchObject({ cursorBlock: null, safeHeadBlock: 0n });
  });

  describe("announcing address mismatches", () => {
    const signal = (accountId: string) => ({
      accountId,
      commitmentMasked: "0xc0de...c0de",
      storedWalletMasked: "0xabcd...ef01",
      onChainSenderMasked: "0x9999...bbbb",
    });
    const announcedAccounts = (logged: Array<{ fields: Record<string, unknown> }>) =>
      logged.filter((line) => line.fields.event === "wallet_registry.address_mismatch").map((line) => line.fields.account_id);

    it("announces a mismatch as the service hands it over, once, with this run's trace id", async () => {
      const { service, logged, metrics } = setup(
        async (hooks) => {
          hooks?.onAddressMismatch?.(signal("acct_a"));
          return summary({ addressMismatches: [signal("acct_a")] });
        },
        async () => 100n,
      );

      await service.execute();

      expect(announcedAccounts(logged)).toEqual(["acct_a"]);
      expect(logged.find((line) => line.fields.account_id === "acct_a")?.fields).toMatchObject({ trace_id: "req_run_1" });
      expect(metrics.render()).toContain("vistablox_worker_wallet_registration_address_mismatches_total 1");
    });

    it("announces it before the failure is reported when the run then fails", async () => {
      const { service, logged } = setup(
        async (hooks) => {
          hooks?.onAddressMismatch?.(signal("acct_a"));
          throw new Error("database blip");
        },
        async () => 100n,
      );

      await expect(service.execute()).rejects.toThrow("database blip");

      expect(announcedAccounts(logged)).toEqual(["acct_a"]);
      expect(logged.map((line) => line.fields.event)).toEqual([
        "wallet_registry.address_mismatch",
        "wallet_registry.watcher_failed",
      ]);
    });

    it("announces it when the cursor read after a completed run fails", async () => {
      const { service, logged, heartbeats } = setup(
        async (hooks) => {
          hooks?.onAddressMismatch?.(signal("acct_a"));
          return summary({ addressMismatches: [signal("acct_a")] });
        },
        async () => {
          throw new Error("database blip");
        },
      );

      await expect(service.execute()).rejects.toThrow("database blip");

      expect(announcedAccounts(logged)).toEqual(["acct_a"]);
      expect(heartbeats).toEqual([]);
    });

    it("numbers the mismatches of one run, so the reporter can stop listing after 20", async () => {
      const { service, logged } = setup(
        async (hooks) => {
          for (let index = 1; index <= 22; index += 1) hooks?.onAddressMismatch?.(signal(`acct_${index}`));
          return summary();
        },
        async () => 100n,
      );

      await service.execute();

      const lines = logged.filter((line) => line.fields.event === "wallet_registry.address_mismatch");
      expect(lines).toHaveLength(21);
      expect(lines[20]?.fields).toMatchObject({ listed_limit: 20 });
    });
  });

  describe("when the watcher fails", () => {
    function viemFailure(): Error {
      return new HttpRequestError({ url: RPC_URL, body: { method: "eth_getLogs" }, details: "fetch failed" });
    }

    it("writes no heartbeat, counts the failure and logs it without the secret", async () => {
      const { service, heartbeats, logged, metrics } = setup(
        async () => {
          throw viemFailure();
        },
        async () => 100n,
      );

      await expect(service.execute()).rejects.toThrow();

      expect(heartbeats).toEqual([]);
      expect(metrics.render()).toContain("vistablox_worker_wallet_registration_failures_total 1");
      expect(metrics.render()).toContain("vistablox_worker_wallet_registration_runs_total 1");
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ level: "warn", fields: { event: "wallet_registry.watcher_failed", trace_id: "req_run_1" } });
      expect(logged[0]?.fields).not.toHaveProperty("err");
      expect(JSON.stringify(logged)).not.toContain(RPC_SECRET);
    });

    it("rethrows an error that carries no secret in its message, stack or serialised form", async () => {
      const { service } = setup(
        async () => {
          throw viemFailure();
        },
        async () => 100n,
      );

      const thrown = await service.execute().then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error;
      // What pg-boss stores as the job's output is the serialised error.
      expect(error.message).not.toContain(RPC_SECRET);
      expect(error.stack).not.toContain(RPC_SECRET);
      expect(JSON.stringify(error)).not.toContain(RPC_SECRET);
      expect(JSON.stringify({ ...error, message: error.message, stack: error.stack, cause: error.cause })).not.toContain(
        RPC_SECRET,
      );
      expect(error.name).toBe("HttpRequestError");
    });

    it("treats a failure to read the cursor as a failed run, not a silent success", async () => {
      const { service, heartbeats, logged } = setup(
        async () => summary(),
        async () => {
          throw new Error("database is down");
        },
      );

      await expect(service.execute()).rejects.toThrow("database is down");

      expect(heartbeats).toEqual([]);
      expect(logged[0]?.fields.event).toBe("wallet_registry.watcher_failed");
    });
  });
});

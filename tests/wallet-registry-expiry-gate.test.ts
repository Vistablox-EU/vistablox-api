import { describe, expect, it, vi } from "vitest";

import { WalletRegistryExpiryGate } from "../src/modules/settlement/application/wallet-registry-expiry-gate.js";
import {
  evaluateWalletRegistryHealth,
  type WalletRegistryAlertThresholds,
} from "../src/modules/settlement/domain/wallet-registry-alert-policy.js";
import type {
  WalletRegistryHealthReading,
  WalletRegistryHeartbeat,
} from "../src/modules/settlement/repository/wallet-registry-health.repository.js";

// The claim expiry sweep skips while the registry watcher is stale or lagging
// (AD-287, decided 2026-11-17). The gate reads the same snapshot as the health
// check and runs the same pure policy with the same thresholds; these tables
// pin which of its verdicts hold the sweep back and where each boundary is.
const now = new Date("2026-11-17T12:00:00.000Z");
const MINUTE = 60_000;
const thresholds: WalletRegistryAlertThresholds = {
  watcherStaleAfterMs: 10 * MINUTE,
  cursorLagAlertBlocks: 900n,
  cursorAheadToleranceBlocks: 32n,
  pendingOverdueAlertCount: 1,
  unmatchedEventsAlertCount: 5,
};
const STALLED = "wallet_registry.watcher_stalled";
const LAG = "wallet_registry.cursor_lag";
const AHEAD = "wallet_registry.cursor_ahead_of_chain";

function heartbeat(overrides: Partial<WalletRegistryHeartbeat> & { ageMs?: number; lagBlocks?: bigint } = {}) {
  const { ageMs = MINUTE, lagBlocks = 0n, ...rest } = overrides;
  const safeHeadBlock = rest.safeHeadBlock ?? 10_000n;
  return {
    completedAt: new Date(now.getTime() - ageMs),
    cursorBlock: safeHeadBlock - lagBlocks,
    safeHeadBlock,
    eventsFound: 0,
    ...rest,
  } satisfies WalletRegistryHeartbeat;
}

function reading(overrides: Partial<WalletRegistryHealthReading> = {}): WalletRegistryHealthReading {
  return {
    heartbeat: heartbeat(),
    pendingTotal: 0,
    pendingOverdue: 0,
    oldestPendingRequestedAt: null,
    unresolvedMismatches: { count: 0, accountIds: [] },
    ...overrides,
  };
}

function gateFor(read: WalletRegistryHealthReading | Error, watcherConfigured = true) {
  const readWalletRegistryHealth = vi.fn(async (_overdueCutoff: Date) => {
    if (read instanceof Error) throw read;
    return read;
  });
  return {
    gate: new WalletRegistryExpiryGate(
      { readWalletRegistryHealth },
      { thresholds, watcherConfigured, pendingOverdueAfterMs: 5 * MINUTE },
    ),
    readWalletRegistryHealth,
  };
}

describe("WalletRegistryExpiryGate", () => {
  describe("heartbeat age (stale)", () => {
    it.each([
      { ageMs: 0, mayExpire: true },
      { ageMs: 10 * MINUTE - 1, mayExpire: true },
      { ageMs: 10 * MINUTE, mayExpire: false },
      { ageMs: 10 * MINUTE + 1, mayExpire: false },
      { ageMs: 3 * 24 * 60 * MINUTE, mayExpire: false },
    ])("a heartbeat $ageMs ms old: mayExpire $mayExpire", async ({ ageMs, mayExpire }) => {
      const { gate } = gateFor(reading({ heartbeat: heartbeat({ ageMs }) }));

      await expect(gate.assess(now)).resolves.toEqual({ mayExpire, reasons: mayExpire ? [] : [STALLED] });
    });

    it("treats a watcher that never completed a run, or whose heartbeat cannot be read, as stale", async () => {
      const { gate } = gateFor(reading({ heartbeat: null }));

      await expect(gate.assess(now)).resolves.toEqual({ mayExpire: false, reasons: [STALLED] });
    });

    it("gives a restarted worker no grace period: only the recorded heartbeat counts", async () => {
      // The health check would not call an 11-minute-old heartbeat stalled one
      // minute after a restart. The sweep must: the watcher has been down.
      const snapshot = reading({ heartbeat: heartbeat({ ageMs: 11 * MINUTE }) });
      const oneMinuteAfterRestart = evaluateWalletRegistryHealth(
        {
          watcherConfigured: true,
          workerStartedAt: new Date(now.getTime() - MINUTE),
          heartbeat: snapshot.heartbeat,
          pendingTotal: 0,
          pendingOverdue: 0,
          oldestPendingRequestedAt: null,
          unresolvedMismatchCount: 0,
          unresolvedMismatchAccountIds: [],
        },
        thresholds,
        now,
      );
      expect(oneMinuteAfterRestart.map((alert) => alert.event)).not.toContain(STALLED);

      const { gate } = gateFor(snapshot);

      await expect(gate.assess(now)).resolves.toEqual({ mayExpire: false, reasons: [STALLED] });
    });
  });

  describe("cursor lag (lagging)", () => {
    it.each([
      { lagBlocks: 0n, mayExpire: true },
      { lagBlocks: 899n, mayExpire: true },
      { lagBlocks: 900n, mayExpire: false },
      { lagBlocks: 901n, mayExpire: false },
      { lagBlocks: 1_000_000n, mayExpire: false },
    ])("a cursor $lagBlocks blocks behind the safe head: mayExpire $mayExpire", async ({ lagBlocks, mayExpire }) => {
      const { gate } = gateFor(reading({ heartbeat: heartbeat({ lagBlocks }) }));

      await expect(gate.assess(now)).resolves.toEqual({ mayExpire, reasons: mayExpire ? [] : [LAG] });
    });

    it("has nothing to say about lag while the watcher has saved no cursor yet", async () => {
      const { gate } = gateFor(reading({ heartbeat: heartbeat({ cursorBlock: null }) }));

      await expect(gate.assess(now)).resolves.toEqual({ mayExpire: true, reasons: [] });
    });
  });

  describe("cursor ahead of the chain", () => {
    it.each([
      { lagBlocks: -32n, mayExpire: true },
      { lagBlocks: -33n, mayExpire: false },
    ])("a cursor $lagBlocks blocks behind the safe head (negative: ahead of it): mayExpire $mayExpire", async ({ lagBlocks, mayExpire }) => {
      const { gate } = gateFor(reading({ heartbeat: heartbeat({ lagBlocks }) }));

      await expect(gate.assess(now)).resolves.toEqual({ mayExpire, reasons: mayExpire ? [] : [AHEAD] });
    });
  });

  it("names every reason when the watcher is stale and its cursor lags", async () => {
    const { gate } = gateFor(reading({ heartbeat: heartbeat({ ageMs: 20 * MINUTE, lagBlocks: 5000n }) }));

    await expect(gate.assess(now)).resolves.toEqual({ mayExpire: false, reasons: [STALLED, LAG] });
  });

  describe("what does not hold the sweep back", () => {
    it("overdue pending claims and unresolved address mismatches, which are about the claims, not the watcher", async () => {
      const { gate } = gateFor(
        reading({
          pendingTotal: 40,
          pendingOverdue: 40,
          oldestPendingRequestedAt: new Date("2026-11-10T00:00:00.000Z"),
          unresolvedMismatches: { count: 2, accountIds: ["acct_1", "acct_2"] },
        }),
      );

      await expect(gate.assess(now)).resolves.toEqual({ mayExpire: true, reasons: [] });
    });

    it.each([
      { name: "no heartbeat", heartbeat: null },
      { name: "an old heartbeat", heartbeat: heartbeat({ ageMs: 5 * 24 * 60 * MINUTE, lagBlocks: 50_000n }) },
    ])("a deployment where no watcher runs (registry address unset, or set without the CHAIN_* settings): $name", async ({ heartbeat: recorded }) => {
      // Nothing can be about to read a claim's event, and the health check
      // reports the missing watcher on its own.
      const { gate } = gateFor(reading({ heartbeat: recorded }), false);

      await expect(gate.assess(now)).resolves.toEqual({ mayExpire: true, reasons: [] });
    });
  });

  it("rejects when the health snapshot cannot be read, so the sweep can fail closed", async () => {
    const { gate } = gateFor(new Error("database unavailable"));

    await expect(gate.assess(now)).rejects.toThrow("database unavailable");
  });

  it("reads the snapshot once per assessment, with the same overdue cutoff the health check uses", async () => {
    const { gate, readWalletRegistryHealth } = gateFor(reading());

    await gate.assess(now);

    expect(readWalletRegistryHealth).toHaveBeenCalledTimes(1);
    expect(readWalletRegistryHealth).toHaveBeenCalledWith(new Date(now.getTime() - 5 * MINUTE));
  });

  it("uses the thresholds it is given, not constants of its own", async () => {
    const aged = reading({ heartbeat: heartbeat({ ageMs: 30 * MINUTE }) });
    const wide = new WalletRegistryExpiryGate(
      { readWalletRegistryHealth: async () => aged },
      {
        thresholds: { ...thresholds, watcherStaleAfterMs: 60 * MINUTE },
        watcherConfigured: true,
        pendingOverdueAfterMs: 5 * MINUTE,
      },
    );

    await expect(wide.assess(now)).resolves.toEqual({ mayExpire: true, reasons: [] });
  });
});

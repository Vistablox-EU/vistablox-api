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
const NOT_CONFIGURED = "wallet_registry.watcher_not_configured";

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
  const recorded = overrides.heartbeat === undefined ? heartbeat() : overrides.heartbeat;
  return {
    heartbeat: recorded,
    // A heartbeat that was read is a trace of the watcher; a test that says
    // otherwise (an unreadable row, a cursor only) passes it explicitly.
    watcherHistoryRecorded: recorded !== null,
    pendingTotal: 0,
    pendingOverdue: 0,
    oldestPendingRequestedAt: null,
    unresolvedMismatches: { count: 0, accountIds: [] },
    flaggedEvidence: { count: 0, accountIds: [] },
    ...overrides,
  };
}

// The worker as it can be configured: a watcher that runs, a registry address
// with no watcher (the CHAIN_* settings are missing), or no registry address.
const RUNNING = { registryConfigured: true, watcherRunnable: true } as const;
const WITHOUT_CHAIN = { registryConfigured: true, watcherRunnable: false } as const;
const REGISTRY_OFF = { registryConfigured: false, watcherRunnable: false } as const;

function gateFor(
  read: WalletRegistryHealthReading | Error,
  worker: { registryConfigured: boolean; watcherRunnable: boolean } = RUNNING,
) {
  const readWalletRegistryHealth = vi.fn(async (_overdueCutoff: Date) => {
    if (read instanceof Error) throw read;
    return read;
  });
  return {
    gate: new WalletRegistryExpiryGate(
      { readWalletRegistryHealth },
      { thresholds, ...worker, pendingOverdueAfterMs: 5 * MINUTE },
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
          flaggedEvidenceCount: 0,
          flaggedEvidenceAccountIds: [],
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
  });

  // A worker whose watcher cannot run is judged by the watcher's history, not
  // by its absence. The policy says "pending claims cannot confirm" for it; what
  // matters to the sweep is whether the watcher has ever read events, because
  // its saved cursor survives and it reads the gap when it resumes.
  describe("a worker whose watcher cannot run", () => {
    const aWatcherThatRan = [
      { name: "a fresh heartbeat", read: reading({ heartbeat: heartbeat({ ageMs: MINUTE }) }) },
      {
        name: "a heartbeat 5 days old with 50,000 blocks of lag",
        read: reading({ heartbeat: heartbeat({ ageMs: 5 * 24 * 60 * MINUTE, lagBlocks: 50_000n }) }),
      },
      {
        // The repository reports history for an unreadable heartbeat row, and for a
        // saved cursor with no heartbeat (a watcher from before heartbeats existed).
        name: "no readable heartbeat, but a row or a saved cursor",
        read: reading({ heartbeat: null, watcherHistoryRecorded: true }),
      },
      { name: "a heartbeat whose run saved no cursor", read: reading({ heartbeat: heartbeat({ cursorBlock: null }) }) },
    ];

    it.each(aWatcherThatRan)(
      "the registry address is set, the CHAIN_* settings are gone, and the database holds $name: the sweep waits",
      async ({ read }) => {
        const { gate } = gateFor(read, WITHOUT_CHAIN);

        await expect(gate.assess(now)).resolves.toEqual({ mayExpire: false, reasons: [NOT_CONFIGURED] });
      },
    );

    it("a heartbeat that is still fresh does not make a watcher that cannot run trustworthy", async () => {
      // Within the stale threshold the health policy would call a running
      // watcher fine. Not running is not that.
      const { gate } = gateFor(reading({ heartbeat: heartbeat({ ageMs: 1 }) }), WITHOUT_CHAIN);

      await expect(gate.assess(now)).resolves.toEqual({ mayExpire: false, reasons: [NOT_CONFIGURED] });
    });

    it("the registry address is set, the CHAIN_* settings were never there and the watcher never ran: nothing is waiting to be read", async () => {
      const { gate } = gateFor(reading({ heartbeat: null, watcherHistoryRecorded: false }), WITHOUT_CHAIN);

      await expect(gate.assess(now)).resolves.toEqual({ mayExpire: true, reasons: [] });
    });

    it.each([
      { name: "no trace of a watcher", read: reading({ heartbeat: null, watcherHistoryRecorded: false }) },
      ...aWatcherThatRan,
    ])("the registry address is unset, so the registry is off here, whatever the database holds ($name): the sweep runs", async ({ read }) => {
      const { gate } = gateFor(read, REGISTRY_OFF);

      await expect(gate.assess(now)).resolves.toEqual({ mayExpire: true, reasons: [] });
    });

    it("says only that the watcher cannot run, not that it is stalled or lagging", async () => {
      const { gate } = gateFor(
        reading({ heartbeat: heartbeat({ ageMs: 20 * MINUTE, lagBlocks: 5000n }) }),
        WITHOUT_CHAIN,
      );

      await expect(gate.assess(now)).resolves.toEqual({ mayExpire: false, reasons: [NOT_CONFIGURED] });
    });

    it("has the same verdict whether or not claims are pending", async () => {
      const withClaims = gateFor(reading({ pendingTotal: 40, pendingOverdue: 40 }), WITHOUT_CHAIN).gate;
      const without = gateFor(reading({ pendingTotal: 0, pendingOverdue: 0 }), WITHOUT_CHAIN).gate;

      await expect(withClaims.assess(now)).resolves.toEqual({ mayExpire: false, reasons: [NOT_CONFIGURED] });
      await expect(without.assess(now)).resolves.toEqual({ mayExpire: false, reasons: [NOT_CONFIGURED] });
    });

    it("leaves a watcher that does run to the health policy, whatever the history flag says", async () => {
      // The flag is only about a watcher that cannot run. A runnable watcher
      // that never completed a run is stale, history or not.
      const never = gateFor(reading({ heartbeat: null, watcherHistoryRecorded: false }), RUNNING).gate;
      const fresh = gateFor(reading({ heartbeat: heartbeat({ ageMs: MINUTE }), watcherHistoryRecorded: false }), RUNNING).gate;

      await expect(never.assess(now)).resolves.toEqual({ mayExpire: false, reasons: [STALLED] });
      await expect(fresh.assess(now)).resolves.toEqual({ mayExpire: true, reasons: [] });
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
        ...RUNNING,
        pendingOverdueAfterMs: 5 * MINUTE,
      },
    );

    await expect(wide.assess(now)).resolves.toEqual({ mayExpire: true, reasons: [] });
  });
});

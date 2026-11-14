import { describe, expect, it } from "vitest";

import {
  WALLET_REGISTRY_ALERT_EVENTS,
  evaluateWalletRegistryHealth,
  evaluateWalletRegistryRun,
  walletRegistryCursorLagBlocks,
  type WalletRegistryAlertThresholds,
  type WalletRegistryHealthSnapshot,
} from "../src/modules/settlement/domain/wallet-registry-alert-policy.js";

const THRESHOLDS: WalletRegistryAlertThresholds = {
  watcherStaleAfterMs: 10 * 60_000,
  cursorLagAlertBlocks: 900n,
  cursorAheadToleranceBlocks: 32n,
  pendingOverdueAlertCount: 1,
  unmatchedEventsAlertCount: 5,
};

const NOW = new Date("2026-11-13T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;

function snapshot(overrides: Partial<WalletRegistryHealthSnapshot> = {}): WalletRegistryHealthSnapshot {
  return {
    watcherConfigured: true,
    workerStartedAt: ago(60 * MINUTE),
    heartbeat: { completedAt: ago(MINUTE), cursorBlock: 1000n, safeHeadBlock: 1000n, eventsFound: 0 },
    pendingTotal: 0,
    pendingOverdue: 0,
    oldestPendingRequestedAt: null,
    unresolvedMismatchCount: 0,
    unresolvedMismatchAccountIds: [],
    ...overrides,
  };
}

function heartbeat(completedAt: Date, cursorBlock: bigint | null, safeHeadBlock: bigint) {
  return { completedAt, cursorBlock, safeHeadBlock, eventsFound: 0 };
}

// "<severity>:<event without prefix>" per alert, so a table row reads as a sentence.
function summarise(overrides: Partial<WalletRegistryHealthSnapshot>): string[] {
  return evaluateWalletRegistryHealth(snapshot(overrides), THRESHOLDS, NOW).map(
    (alert) => `${alert.severity}:${alert.event.replace("wallet_registry.", "")}`,
  );
}

describe("evaluateWalletRegistryHealth", () => {
  it("raises nothing for a healthy watcher", () => {
    expect(summarise({})).toEqual([]);
  });

  describe("stalled watcher", () => {
    it.each([
      ["9 minutes 59 seconds old is still healthy", ago(10 * MINUTE - 1000), []],
      ["exactly 10 minutes old is stalled", ago(10 * MINUTE), ["error:watcher_stalled"]],
      ["an hour old is stalled", ago(60 * MINUTE), ["error:watcher_stalled"]],
    ])("%s", (_label, completedAt, expected) => {
      expect(summarise({ heartbeat: heartbeat(completedAt, 1000n, 1000n) })).toEqual(expected);
    });

    it("says the heartbeat went stale when a run completed since the worker started", () => {
      const [alert] = evaluateWalletRegistryHealth(
        snapshot({ heartbeat: heartbeat(ago(25 * MINUTE), 1000n, 1000n) }),
        THRESHOLDS,
        NOW,
      );
      expect(alert?.details).toEqual({ reason: "heartbeat_stale", age_seconds: 25 * 60, stale_after_seconds: 600 });
    });

    it("calls a worker with no run since it started stalled only after a full threshold", () => {
      expect(summarise({ heartbeat: null, workerStartedAt: ago(2 * MINUTE) })).toEqual([]);
      expect(summarise({ heartbeat: null, workerStartedAt: ago(9 * MINUTE + 59_000) })).toEqual([]);
      const [alert] = evaluateWalletRegistryHealth(
        snapshot({ heartbeat: null, workerStartedAt: ago(60 * MINUTE) }),
        THRESHOLDS,
        NOW,
      );
      expect(alert).toMatchObject({
        event: WALLET_REGISTRY_ALERT_EVENTS.watcherStalled,
        severity: "error",
        details: { reason: "no_completed_run_since_start", age_seconds: 3600 },
      });
    });

    it("gives a restarted worker a grace period even though the old heartbeat is hours old", () => {
      const old = heartbeat(ago(3 * 60 * MINUTE), 1000n, 1000n);
      expect(summarise({ heartbeat: old, workerStartedAt: ago(MINUTE) })).toEqual([]);
      expect(summarise({ heartbeat: old, workerStartedAt: ago(10 * MINUTE) })).toEqual(["error:watcher_stalled"]);
    });
  });

  describe("cursor lag", () => {
    it.each([
      ["899 blocks behind is tolerated", 101n, 1000n, []],
      ["900 blocks behind alerts", 100n, 1000n, ["error:cursor_lag"]],
      ["far behind alerts", 0n, 100_000n, ["error:cursor_lag"]],
      ["caught up is healthy", 1000n, 1000n, []],
    ])("%s", (_label, cursor, head, expected) => {
      expect(summarise({ heartbeat: heartbeat(ago(MINUTE), cursor, head) })).toEqual(expected);
    });

    it("reports positions as decimal strings, never as numbers or hex", () => {
      const [alert] = evaluateWalletRegistryHealth(
        snapshot({ heartbeat: heartbeat(ago(MINUTE), 100n, 1000n) }),
        THRESHOLDS,
        NOW,
      );
      expect(alert?.details).toEqual({
        lag_blocks: "900",
        threshold_blocks: "900",
        cursor_block: "100",
        safe_head_block: "1000",
      });
    });

    it("does not judge lag before the first cursor exists", () => {
      expect(summarise({ heartbeat: heartbeat(ago(MINUTE), null, 1000n) })).toEqual([]);
    });
  });

  describe("cursor ahead of the chain", () => {
    it.each([
      ["32 blocks ahead is the watcher's normal overlap", 1032n, []],
      ["33 blocks ahead alerts", 1033n, ["error:cursor_ahead_of_chain"]],
      ["far ahead alerts", 5000n, ["error:cursor_ahead_of_chain"]],
    ])("%s", (_label, cursor, expected) => {
      expect(summarise({ heartbeat: heartbeat(ago(MINUTE), cursor, 1000n) })).toEqual(expected);
    });
  });

  describe("watcher not configured", () => {
    it("is a warning while nothing is waiting on it", () => {
      expect(summarise({ watcherConfigured: false, heartbeat: null })).toEqual(["warn:watcher_not_configured"]);
    });

    it("is an error once an investor has a claim that can never confirm", () => {
      expect(summarise({ watcherConfigured: false, heartbeat: null, pendingTotal: 2 })).toEqual([
        "error:watcher_not_configured",
      ]);
    });

    it("does not also report a stalled watcher or a lag for a watcher that cannot run", () => {
      expect(
        summarise({ watcherConfigured: false, heartbeat: null, workerStartedAt: ago(24 * 60 * MINUTE) }),
      ).toEqual(["warn:watcher_not_configured"]);
    });
  });

  describe("pending claims", () => {
    it("warns when the overdue count reaches the threshold, with the original message text", () => {
      expect(summarise({ pendingTotal: 3, pendingOverdue: 0 })).toEqual([]);
      const alerts = evaluateWalletRegistryHealth(
        snapshot({ pendingTotal: 3, pendingOverdue: 2, oldestPendingRequestedAt: ago(90 * MINUTE) }),
        THRESHOLDS,
        NOW,
      );
      expect(alerts).toEqual([
        {
          event: "wallet_registry.pending_overdue",
          severity: "warn",
          message: "wallet registrations pending beyond approval threshold",
          details: {
            pending_registrations_overdue: 2,
            pending_total: 3,
            threshold_count: 1,
            oldest_pending_age_seconds: 5400,
          },
        },
      ]);
    });

    it("honours a higher count threshold", () => {
      const thresholds = { ...THRESHOLDS, pendingOverdueAlertCount: 3 };
      const run = (pendingOverdue: number) =>
        evaluateWalletRegistryHealth(snapshot({ pendingTotal: 5, pendingOverdue }), thresholds, NOW).length;
      expect([run(2), run(3), run(4)]).toEqual([0, 1, 1]);
    });
  });

  describe("unresolved address mismatches", () => {
    it("warns while one is open and names the accounts, not the addresses", () => {
      const alerts = evaluateWalletRegistryHealth(
        snapshot({ unresolvedMismatchCount: 2, unresolvedMismatchAccountIds: ["acct_a", "acct_b"] }),
        THRESHOLDS,
        NOW,
      );
      expect(alerts).toEqual([
        {
          event: "wallet_registry.address_mismatch_unresolved",
          severity: "warn",
          message: "wallet registration address mismatch is still unresolved",
          details: { unresolved_count: 2, account_ids: ["acct_a", "acct_b"] },
        },
      ]);
    });
  });

  it("reports several problems at once, errors for the watcher before warnings for the claims", () => {
    expect(
      summarise({
        heartbeat: heartbeat(ago(30 * MINUTE), 0n, 5000n),
        pendingTotal: 4,
        pendingOverdue: 4,
        unresolvedMismatchCount: 1,
      }),
    ).toEqual(["error:watcher_stalled", "error:cursor_lag", "warn:pending_overdue", "warn:address_mismatch_unresolved"]);
  });

  it("is pure: the same snapshot, thresholds and time always give the same alerts", () => {
    const input = snapshot({ heartbeat: heartbeat(ago(30 * MINUTE), 0n, 5000n), pendingTotal: 1, pendingOverdue: 1 });
    expect(evaluateWalletRegistryHealth(input, THRESHOLDS, NOW)).toEqual(
      evaluateWalletRegistryHealth(input, THRESHOLDS, NOW),
    );
    // Moving only the clock moves the outcome: time is an input, not read.
    expect(evaluateWalletRegistryHealth(snapshot({ heartbeat: heartbeat(ago(5 * MINUTE), 1000n, 1000n) }), THRESHOLDS, NOW)).toEqual([]);
    expect(
      evaluateWalletRegistryHealth(
        snapshot({ heartbeat: heartbeat(ago(5 * MINUTE), 1000n, 1000n) }),
        THRESHOLDS,
        new Date(NOW.getTime() + 6 * MINUTE),
      ),
    ).toHaveLength(1);
  });

  it("never puts a long hex run in an alert, whatever the snapshot holds", () => {
    const alerts = evaluateWalletRegistryHealth(
      snapshot({
        heartbeat: heartbeat(ago(30 * MINUTE), 0n, 5000n),
        pendingTotal: 4,
        pendingOverdue: 4,
        unresolvedMismatchCount: 1,
        unresolvedMismatchAccountIds: ["acct_a"],
      }),
      THRESHOLDS,
      NOW,
    );
    expect(JSON.stringify(alerts, (_key, value: unknown) => (typeof value === "bigint" ? String(value) : value))).not.toMatch(
      /0x[0-9a-fA-F]{8,}/,
    );
  });
});

describe("walletRegistryCursorLagBlocks", () => {
  it("is the safe head minus the cursor, negative when the cursor is ahead, and null without a cursor", () => {
    expect(walletRegistryCursorLagBlocks(heartbeat(NOW, 90n, 100n))).toBe(10n);
    expect(walletRegistryCursorLagBlocks(heartbeat(NOW, 110n, 100n))).toBe(-10n);
    expect(walletRegistryCursorLagBlocks(heartbeat(NOW, null, 100n))).toBeNull();
  });
});

describe("evaluateWalletRegistryRun", () => {
  it.each([
    [0, 0],
    [4, 0],
    [5, 1],
    [50, 1],
  ])("%i new unmatched events gives %i alerts at the default threshold of 5", (newUnmatchedEvents, expected) => {
    expect(evaluateWalletRegistryRun({ newUnmatchedEvents }, THRESHOLDS)).toHaveLength(expected);
  });

  it("raises a warning with the count and threshold", () => {
    expect(evaluateWalletRegistryRun({ newUnmatchedEvents: 7 }, THRESHOLDS)).toEqual([
      {
        event: "wallet_registry.unmatched_events",
        severity: "warn",
        message: "wallet registry events matched no pending registration",
        details: { new_unmatched_events: 7, threshold_count: 5 },
      },
    ]);
  });
});

describe("WALLET_REGISTRY_ALERT_EVENTS", () => {
  it("names every event with the wallet_registry. prefix and no duplicates", () => {
    const names = Object.values(WALLET_REGISTRY_ALERT_EVENTS);
    expect(names.every((name) => /^wallet_registry\.[a-z_]+$/.test(name))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});

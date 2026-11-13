import { HttpRequestError } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { ConfirmWalletRegistrationsSummary } from "../src/modules/settlement/application/confirm-wallet-registrations.service.js";
import { WalletRegistryAlertReporter } from "../src/modules/settlement/application/wallet-registry-alert-reporter.js";
import {
  WALLET_REGISTRY_ALERT_EVENTS,
  evaluateWalletRegistryHealth,
  type WalletRegistryAlertThresholds,
  type WalletRegistryHealthSnapshot,
} from "../src/modules/settlement/domain/wallet-registry-alert-policy.js";
import type { WalletRegistryHeartbeat } from "../src/modules/settlement/repository/wallet-registry-health.repository.js";
import { WorkerMetrics } from "../src/shared/health/worker-metrics.js";

const THRESHOLDS: WalletRegistryAlertThresholds = {
  watcherStaleAfterMs: 10 * 60_000,
  cursorLagAlertBlocks: 900n,
  cursorAheadToleranceBlocks: 32n,
  pendingOverdueAlertCount: 1,
  unmatchedEventsAlertCount: 5,
};
const JOBS = { watcher: "settlement.confirm_wallet_registrations", health: "settlement.check_wallet_registry_health" };
const NOW = new Date("2026-11-13T12:00:00.000Z");
const TRACE = "req_test_1";

const RPC_SECRET = "SECRETPROVIDERKEY123";
const RPC_URL = `https://base-sepolia.g.alchemy.com/v2/${RPC_SECRET}`;
// Full values the reporter must never write, in any case.
const FULL_VALUES = [
  "0xAbCdEf0123456789aBcDeF0123456789abcdef01",
  `0x${"c0de".repeat(16)}`,
  "0x9999999999aaaaaaaaaa0000000000bbbbbbbbbb",
];
const LONG_HEX = /0x[0-9a-fA-F]{12,}/;

type Call = { level: "info" | "warn" | "error"; fields: Record<string, unknown>; message: string };

function fakeLogger() {
  const calls: Call[] = [];
  const at = (level: Call["level"]) =>
    vi.fn((fields: Record<string, unknown>, message: string) => {
      calls.push({ level, fields, message });
    });
  return { logger: { info: at("info"), warn: at("warn"), error: at("error") }, calls };
}

function setup(options: { failHeartbeat?: Error } = {}) {
  const { logger, calls } = fakeLogger();
  const metrics = new WorkerMetrics();
  const heartbeats: WalletRegistryHeartbeat[] = [];
  const reporter = new WalletRegistryAlertReporter({
    logger: logger as never,
    metrics,
    heartbeats: {
      recordWatcherHeartbeat: async (input) => {
        if (options.failHeartbeat !== undefined) throw options.failHeartbeat;
        heartbeats.push(input);
      },
    },
    thresholds: THRESHOLDS,
    jobs: JOBS,
    clock: () => NOW,
  });
  const metric = (name: string): number | undefined => {
    const line = metrics.render().split("\n").find((entry) => entry.startsWith(`${name} `));
    return line === undefined ? undefined : Number(line.split(" ")[1]);
  };
  const events = (name: string) => calls.filter((call) => call.fields.event === name);
  return { reporter, calls, heartbeats, metric, events, metrics };
}

function summary(overrides: Partial<ConfirmWalletRegistrationsSummary> = {}): ConfirmWalletRegistrationsSummary {
  return {
    fromBlock: "69",
    toBlock: "117",
    safeHeadBlock: "117",
    eventsFound: 2,
    registrationsConfirmed: 1,
    unmatchedEvents: 1,
    newUnmatchedEvents: 0,
    addressMismatches: [],
    addressMismatchesRepeated: 0,
    pendingRegistrationsOverdue: 0,
    pendingWarnAfterMinutes: 5,
    ...overrides,
  };
}

const mismatch = (accountId: string) => ({
  accountId,
  commitmentMasked: "0xc0de...c0de",
  storedWalletMasked: "0xabcd...ef01",
  onChainSenderMasked: "0x9999...bbbb",
});

describe("reportRun", () => {
  it("keeps the completion line and the existing counters and gauge", async () => {
    const { reporter, calls, metric } = setup();
    reporter.runStarted();

    await reporter.reportRun(
      summary({ registrationsConfirmed: 2, unmatchedEvents: 3, newUnmatchedEvents: 1, pendingRegistrationsOverdue: 4 }),
      117n,
      TRACE,
    );

    expect(calls[0]).toMatchObject({
      level: "info",
      message: "case timer job completed",
      fields: { trace_id: TRACE, job: JOBS.watcher, registrationsConfirmed: 2, safeHeadBlock: "117" },
    });
    expect(metric("vistablox_worker_wallet_registration_runs_total")).toBe(1);
    expect(metric("vistablox_worker_wallet_registration_confirmed_total")).toBe(2);
    expect(metric("vistablox_worker_wallet_registration_unmatched_events_total")).toBe(3);
    expect(metric("vistablox_worker_wallet_registration_new_unmatched_events_total")).toBe(1);
    expect(metric("vistablox_worker_wallet_registration_pending_overdue")).toBe(4);
  });

  it("writes the heartbeat with the run's own safe head, the saved cursor and the event count", async () => {
    const { reporter, heartbeats } = setup();

    await reporter.reportRun(summary({ safeHeadBlock: "117", eventsFound: 7 }), 100n, TRACE);

    expect(heartbeats).toEqual([{ completedAt: NOW, safeHeadBlock: 117n, cursorBlock: 100n, eventsFound: 7 }]);
  });

  it("does not announce mismatches itself: they were announced as they were claimed", async () => {
    const { reporter, calls, events, metric } = setup();
    reporter.runStarted();

    await reporter.reportRun(
      summary({ addressMismatches: [mismatch("acct_a")], addressMismatchesRepeated: 3 }),
      117n,
      TRACE,
    );

    expect(events(WALLET_REGISTRY_ALERT_EVENTS.addressMismatch)).toEqual([]);
    // They stay in the completion line, masked, as part of the run's summary.
    expect(calls[0]?.fields.addressMismatches).toEqual([mismatch("acct_a")]);
    // Registered at 0 when the run started (so a rate over it sees the first
    // mismatch), and not counted again from the summary.
    expect(metric("vistablox_worker_wallet_registration_address_mismatches_total")).toBe(0);
    expect(metric("vistablox_worker_wallet_registration_address_mismatch_duplicates_total")).toBe(3);
  });

  it.each([
    [4, 0],
    [5, 1],
  ])("raises the unmatched-events warning for %i new events: %i line(s)", async (newUnmatchedEvents, expected) => {
    const { reporter, events } = setup();

    await reporter.reportRun(summary({ unmatchedEvents: 10, newUnmatchedEvents }), 117n, TRACE);

    const lines = events(WALLET_REGISTRY_ALERT_EVENTS.unmatchedEvents);
    expect(lines).toHaveLength(expected);
    if (expected > 0) {
      expect(lines[0]).toMatchObject({
        level: "warn",
        fields: { severity: "warn", job: JOBS.watcher, trace_id: TRACE, new_unmatched_events: 5, threshold_count: 5 },
      });
    }
  });

  it("no longer logs the per-run overdue warning; the health check owns it", async () => {
    const { reporter, events } = setup();

    await reporter.reportRun(summary({ pendingRegistrationsOverdue: 9 }), 117n, TRACE);

    expect(events(WALLET_REGISTRY_ALERT_EVENTS.pendingOverdue)).toEqual([]);
  });

  describe("when the heartbeat cannot be written", () => {
    it("reports it as a warning and a counter, and still completes and logs the run", async () => {
      const failure = new Error(`connection to ${RPC_URL} lost, wallet ${FULL_VALUES[0]}`);
      const { reporter, calls, events, metric } = setup({ failHeartbeat: failure });

      await expect(reporter.reportRun(summary(), 117n, TRACE)).resolves.toBeUndefined();

      const [line] = events(WALLET_REGISTRY_ALERT_EVENTS.heartbeatWriteFailed);
      expect(line).toMatchObject({ level: "warn", fields: { severity: "warn", job: JOBS.watcher, trace_id: TRACE } });
      expect(String(line?.fields.error_message)).not.toContain(RPC_SECRET);
      expect(metric("vistablox_worker_wallet_registration_heartbeat_write_failures_total")).toBe(1);
      // The run's own completion line is still there.
      expect(calls.some((call) => call.message === "case timer job completed")).toBe(true);
    });
  });
});

describe("announceAddressMismatch", () => {
  it("announces a first-seen mismatch as an error event with exactly these fields, and counts it", () => {
    const { reporter, events, metric } = setup();

    reporter.announceAddressMismatch(mismatch("acct_a"), TRACE, 1);

    const lines = events(WALLET_REGISTRY_ALERT_EVENTS.addressMismatch);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      level: "error",
      message: "wallet registration event address mismatch -- possible spoofed registration attempt",
      fields: {
        event: "wallet_registry.address_mismatch",
        severity: "error",
        job: JOBS.watcher,
        trace_id: TRACE,
        account_id: "acct_a",
        commitment_masked: "0xc0de...c0de",
        stored_wallet_masked: "0xabcd...ef01",
        on_chain_sender_masked: "0x9999...bbbb",
      },
    });
    expect(metric("vistablox_worker_wallet_registration_address_mismatches_total")).toBe(1);
  });

  it("lists at most 20 mismatches per run, then says so once, and still counts every one", () => {
    const { reporter, events, metric } = setup();

    for (let ordinal = 1; ordinal <= 25; ordinal += 1) {
      reporter.announceAddressMismatch(mismatch(`acct_${ordinal}`), TRACE, ordinal);
    }

    const lines = events(WALLET_REGISTRY_ALERT_EVENTS.addressMismatch);
    expect(lines).toHaveLength(21);
    expect(lines.slice(0, 20).map((line) => line.fields.account_id)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => `acct_${index + 1}`),
    );
    expect(lines[20]?.level).toBe("error");
    expect(lines[20]?.fields).toEqual({
      event: "wallet_registry.address_mismatch",
      severity: "error",
      job: JOBS.watcher,
      trace_id: TRACE,
      listed_limit: 20,
    });
    expect(metric("vistablox_worker_wallet_registration_address_mismatches_total")).toBe(25);
  });
});

describe("reportFailure", () => {
  function viemFailure(): Error {
    return new HttpRequestError({ url: RPC_URL, body: { method: "eth_getLogs" }, details: "fetch failed" });
  }

  it("logs a warning event with a sanitised message and never the error object", () => {
    const { reporter, calls, metric } = setup();

    const rethrown = reporter.reportFailure(viemFailure(), TRACE);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      level: "warn",
      message: "wallet registry watcher run failed",
      fields: {
        event: "wallet_registry.watcher_failed",
        severity: "warn",
        job: JOBS.watcher,
        trace_id: TRACE,
        error_name: "HttpRequestError",
      },
    });
    expect(calls[0]?.fields).not.toHaveProperty("err");
    expect(String(calls[0]?.fields.error_message)).toContain("fetch failed");
    expect(JSON.stringify(calls)).not.toContain(RPC_SECRET);
    expect(rethrown).toBeInstanceOf(Error);
    expect(metric("vistablox_worker_wallet_registration_failures_total")).toBe(1);
  });

  it("returns an error that carries no secret in its message, stack or serialised form", () => {
    const { reporter } = setup();

    const rethrown = reporter.reportFailure(viemFailure(), TRACE);

    expect(rethrown.message).not.toContain(RPC_SECRET);
    expect(rethrown.stack).not.toContain(RPC_SECRET);
    expect(JSON.stringify(rethrown)).not.toContain(RPC_SECRET);
    expect(Object.keys(rethrown).filter((key) => key !== "name")).toEqual([]);
  });

  it("caps the logged message at 500 characters", () => {
    const { reporter, calls } = setup();

    reporter.reportFailure(new Error("x".repeat(5_000)), TRACE);

    expect(String(calls[0]?.fields.error_message)).toHaveLength(500);
  });
});

function snapshot(overrides: Partial<WalletRegistryHealthSnapshot> = {}): WalletRegistryHealthSnapshot {
  return {
    watcherConfigured: true,
    workerStartedAt: new Date(NOW.getTime() - 3_600_000),
    heartbeat: { completedAt: new Date(NOW.getTime() - 60_000), cursorBlock: 1000n, safeHeadBlock: 1010n, eventsFound: 0 },
    pendingTotal: 0,
    pendingOverdue: 0,
    oldestPendingRequestedAt: null,
    unresolvedMismatchCount: 0,
    unresolvedMismatchAccountIds: [],
    ...overrides,
  };
}

describe("reportHealth", () => {
  it("logs a proof-of-life line every time and nothing else for a healthy watcher", () => {
    const { reporter, calls } = setup();
    const input = snapshot();

    reporter.reportHealth(input, evaluateWalletRegistryHealth(input, THRESHOLDS, NOW), TRACE, NOW);

    expect(calls).toEqual([
      {
        level: "info",
        message: "wallet registry health checked",
        fields: {
          event: "wallet_registry.health_checked",
          severity: "info",
          job: JOBS.health,
          trace_id: TRACE,
          watcher_configured: true,
          heartbeat_age_seconds: 60,
          cursor_block: "1000",
          safe_head_block: "1010",
          cursor_lag_blocks: "10",
          pending_total: 0,
          pending_overdue: 0,
          unresolved_address_mismatches: 0,
          alerts_active: 0,
        },
      },
    ]);
  });

  it("logs each alert at its own level, with its fields, after the proof-of-life line", () => {
    const { reporter, calls } = setup();
    const input = snapshot({
      heartbeat: { completedAt: new Date(NOW.getTime() - 30 * 60_000), cursorBlock: 0n, safeHeadBlock: 5000n, eventsFound: 0 },
      pendingTotal: 3,
      pendingOverdue: 2,
      oldestPendingRequestedAt: new Date(NOW.getTime() - 90 * 60_000),
      unresolvedMismatchCount: 1,
      unresolvedMismatchAccountIds: ["acct_a"],
    });
    const alerts = evaluateWalletRegistryHealth(input, THRESHOLDS, NOW);

    reporter.reportHealth(input, alerts, TRACE, NOW);

    expect(calls.map((call) => [call.level, call.fields.event])).toEqual([
      ["info", "wallet_registry.health_checked"],
      ["error", "wallet_registry.watcher_stalled"],
      ["error", "wallet_registry.cursor_lag"],
      ["warn", "wallet_registry.pending_overdue"],
      ["warn", "wallet_registry.address_mismatch_unresolved"],
    ]);
    expect(calls[1]?.fields).toEqual({
      event: "wallet_registry.watcher_stalled",
      severity: "error",
      job: JOBS.health,
      trace_id: TRACE,
      reason: "heartbeat_stale",
      age_seconds: 1800,
      stale_after_seconds: 600,
    });
    expect(calls[3]).toMatchObject({
      message: "wallet registrations pending beyond approval threshold",
      fields: { pending_registrations_overdue: 2, pending_total: 3, oldest_pending_age_seconds: 5400 },
    });
    expect(calls[0]?.fields.alerts_active).toBe(4);
  });

  it("sets the gauges, with -1 for the age and 0 for the lag before any heartbeat exists", () => {
    const { reporter, metric } = setup();

    const input = snapshot({ pendingTotal: 6, pendingOverdue: 2, unresolvedMismatchCount: 1 });
    reporter.reportHealth(input, evaluateWalletRegistryHealth(input, THRESHOLDS, NOW), TRACE, NOW);
    expect(metric("vistablox_worker_wallet_registration_pending_total")).toBe(6);
    expect(metric("vistablox_worker_wallet_registration_watcher_heartbeat_age_seconds")).toBe(60);
    expect(metric("vistablox_worker_wallet_registration_cursor_lag_blocks")).toBe(10);
    expect(metric("vistablox_worker_wallet_registration_address_mismatch_unresolved")).toBe(1);
    expect(metric("vistablox_worker_wallet_registration_health_alerts_active")).toBe(2);

    const none = snapshot({ heartbeat: null });
    reporter.reportHealth(none, [], TRACE, NOW);
    expect(metric("vistablox_worker_wallet_registration_watcher_heartbeat_age_seconds")).toBe(-1);
    expect(metric("vistablox_worker_wallet_registration_cursor_lag_blocks")).toBe(0);
    expect(metric("vistablox_worker_wallet_registration_health_alerts_active")).toBe(0);
  });
});

describe("reportHealthFailure", () => {
  it("logs an error event, counts it and returns a sanitised error", () => {
    const { reporter, calls, metric } = setup();

    const rethrown = reporter.reportHealthFailure(new Error(`cannot reach ${RPC_URL}`), TRACE);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      level: "error",
      fields: { event: "wallet_registry.health_check_failed", severity: "error", job: JOBS.health, trace_id: TRACE },
    });
    expect(JSON.stringify(calls)).not.toContain(RPC_SECRET);
    expect(rethrown.message).not.toContain(RPC_SECRET);
    expect(metric("vistablox_worker_wallet_registration_health_check_failures_total")).toBe(1);
  });
});

describe("what the reporter writes", () => {
  // The sensitive values go in through every path that accepts free text or an
  // identifier: error messages (a database or RPC error can quote them) and a
  // snapshot's account ids. Nothing logged or counted may contain them.
  it("never contains a full address or commitment, however it reaches the reporter", async () => {
    const { reporter, calls, metrics } = setup({
      failHeartbeat: new Error(`wallet_address ${FULL_VALUES[0]} commitment ${FULL_VALUES[1]} at ${RPC_URL}`),
    });
    const quoting = new Error(`Key (wallet_address)=(${FULL_VALUES[0]}) sender ${FULL_VALUES[2]} ${RPC_URL}`);

    reporter.runStarted();
    reporter.announceAddressMismatch(mismatch("acct_a"), TRACE, 1);
    await reporter.reportRun(
      summary({ addressMismatches: [mismatch("acct_a")], newUnmatchedEvents: 9, unmatchedEvents: 9 }),
      117n,
      TRACE,
    );
    reporter.reportFailure(quoting, TRACE);
    reporter.reportHealthFailure(quoting, TRACE);
    const input = snapshot({
      heartbeat: { completedAt: new Date(NOW.getTime() - 3_600_000), cursorBlock: 0n, safeHeadBlock: 9000n, eventsFound: 0 },
      pendingTotal: 2,
      pendingOverdue: 2,
      unresolvedMismatchCount: 1,
      unresolvedMismatchAccountIds: ["acct_a"],
    });
    reporter.reportHealth(input, evaluateWalletRegistryHealth(input, THRESHOLDS, NOW), TRACE, NOW);

    expect(calls.length).toBeGreaterThan(6);
    const everything = JSON.stringify(calls) + metrics.render();
    expect(everything).not.toMatch(LONG_HEX);
    for (const value of FULL_VALUES) expect(everything.toLowerCase()).not.toContain(value.toLowerCase());
    expect(everything).not.toContain(RPC_SECRET);
  });
});

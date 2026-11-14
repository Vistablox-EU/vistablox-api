// The alert policy for the wallet-registry watcher: pure functions from a
// snapshot of what the platform can see to the alerts it should raise. No clock
// reads, no I/O, no imports -- the clock and the worker's start time are
// inputs, so every boundary below is pinned by a table test.
//
// Severity is "error" for what needs a person the same business day (the
// watcher is not running, is far behind, or points at the wrong chain; a
// registration was attempted from the wrong address) and "warn" for what is a
// ticket (an abandoned onboarding, unknown events, an unresolved mismatch).
// Who is paged and how is not decided here (see the runbook).

/**
 * The stable event names an alert rule keys on. Renaming one breaks every
 * rule built on it, so a test checks each against the runbook.
 */
export const WALLET_REGISTRY_ALERT_EVENTS = {
  addressMismatch: "wallet_registry.address_mismatch",
  addressMismatchUnresolved: "wallet_registry.address_mismatch_unresolved",
  watcherNotConfigured: "wallet_registry.watcher_not_configured",
  watcherStalled: "wallet_registry.watcher_stalled",
  watcherFailed: "wallet_registry.watcher_failed",
  cursorLag: "wallet_registry.cursor_lag",
  cursorAheadOfChain: "wallet_registry.cursor_ahead_of_chain",
  pendingOverdue: "wallet_registry.pending_overdue",
  unmatchedEvents: "wallet_registry.unmatched_events",
  heartbeatWriteFailed: "wallet_registry.heartbeat_write_failed",
  healthChecked: "wallet_registry.health_checked",
  healthCheckFailed: "wallet_registry.health_check_failed",
} as const;

export type WalletRegistryAlertEvent =
  (typeof WALLET_REGISTRY_ALERT_EVENTS)[keyof typeof WALLET_REGISTRY_ALERT_EVENTS];

export type WalletRegistryAlertSeverity = "error" | "warn";

export interface WalletRegistryAlertThresholds {
  // No completed watcher run for this long (a worker restart resets the clock).
  watcherStaleAfterMs: number;
  // Saved cursor at least this many blocks behind the safe head.
  cursorLagAlertBlocks: bigint;
  // A cursor ahead of the safe head by up to this many blocks is normal: the
  // watcher re-reads its last blocks, so the cursor can sit just past a head
  // that a node reports a moment later. Beyond it the RPC is behind or on
  // another chain. The worker wires the watcher's own overlap in here.
  cursorAheadToleranceBlocks: bigint;
  // This many claims pending past the age threshold.
  pendingOverdueAlertCount: number;
  // This many events matching no pending claim in a single run.
  unmatchedEventsAlertCount: number;
}

/** What the watcher wrote after its last completed run. */
export interface WalletRegistryHeartbeatSnapshot {
  completedAt: Date;
  cursorBlock: bigint | null;
  safeHeadBlock: bigint;
  eventsFound: number;
}

export interface WalletRegistryHealthSnapshot {
  // The watcher job exists in this worker. False when the registry address is
  // set but the CHAIN_* settings it also needs are not.
  watcherConfigured: boolean;
  workerStartedAt: Date;
  heartbeat: WalletRegistryHeartbeatSnapshot | null;
  pendingTotal: number;
  pendingOverdue: number;
  oldestPendingRequestedAt: Date | null;
  // Accounts with a recorded address mismatch whose current claim still has
  // that commitment and is unconfirmed.
  unresolvedMismatchCount: number;
  unresolvedMismatchAccountIds: readonly string[];
}

export interface WalletRegistryAlert {
  event: WalletRegistryAlertEvent;
  severity: WalletRegistryAlertSeverity;
  message: string;
  // Identifiers and counts only: account ids, block numbers as decimal strings,
  // masked values. Never an address or a commitment.
  details: Readonly<Record<string, string | number | boolean | null | readonly string[]>>;
}

/** Blocks between the safe head and the saved cursor as of the last run; negative when the cursor is ahead. */
export function walletRegistryCursorLagBlocks(heartbeat: WalletRegistryHeartbeatSnapshot): bigint | null {
  return heartbeat.cursorBlock === null ? null : heartbeat.safeHeadBlock - heartbeat.cursorBlock;
}

function secondsBetween(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / 1000);
}

export function evaluateWalletRegistryHealth(
  snapshot: WalletRegistryHealthSnapshot,
  thresholds: WalletRegistryAlertThresholds,
  now: Date,
): WalletRegistryAlert[] {
  const alerts: WalletRegistryAlert[] = [];

  if (!snapshot.watcherConfigured) {
    // The registry address is set, so claims are being created, but without the
    // CHAIN_* settings no watcher runs and none can ever confirm.
    alerts.push({
      event: WALLET_REGISTRY_ALERT_EVENTS.watcherNotConfigured,
      severity: snapshot.pendingTotal > 0 ? "error" : "warn",
      message: "wallet registry address is configured but the watcher cannot run; pending claims cannot confirm",
      details: { pending_total: snapshot.pendingTotal },
    });
  } else {
    // The clock starts at the later of the last completed run and this
    // worker's start, so a deploy, or a restart after a long outage, gets one
    // full threshold to complete a run before it is called stalled.
    const heartbeatAt = snapshot.heartbeat?.completedAt ?? null;
    const reference =
      heartbeatAt !== null && heartbeatAt.getTime() > snapshot.workerStartedAt.getTime()
        ? heartbeatAt
        : snapshot.workerStartedAt;
    const sinceRestart = reference === snapshot.workerStartedAt;
    const ageMs = now.getTime() - reference.getTime();
    if (ageMs >= thresholds.watcherStaleAfterMs) {
      alerts.push({
        event: WALLET_REGISTRY_ALERT_EVENTS.watcherStalled,
        severity: "error",
        message: "wallet registry watcher has not completed a run within the threshold",
        details: {
          reason: sinceRestart ? "no_completed_run_since_start" : "heartbeat_stale",
          age_seconds: Math.floor(ageMs / 1000),
          stale_after_seconds: Math.floor(thresholds.watcherStaleAfterMs / 1000),
        },
      });
    }

    // Lag comes from the safe head and cursor the heartbeat recorded together,
    // never from the live cursor row against an older heartbeat: those two are
    // written at different moments and would disagree by up to one run.
    const heartbeat = snapshot.heartbeat;
    const lag = heartbeat === null ? null : walletRegistryCursorLagBlocks(heartbeat);
    if (heartbeat !== null && lag !== null) {
      const position = {
        cursor_block: String(heartbeat.cursorBlock),
        safe_head_block: String(heartbeat.safeHeadBlock),
      };
      if (lag >= thresholds.cursorLagAlertBlocks) {
        alerts.push({
          event: WALLET_REGISTRY_ALERT_EVENTS.cursorLag,
          severity: "error",
          message: "wallet registry watcher cursor is far behind the chain",
          details: { lag_blocks: String(lag), threshold_blocks: String(thresholds.cursorLagAlertBlocks), ...position },
        });
      }
      if (-lag > thresholds.cursorAheadToleranceBlocks) {
        alerts.push({
          event: WALLET_REGISTRY_ALERT_EVENTS.cursorAheadOfChain,
          severity: "error",
          message: "wallet registry watcher cursor is ahead of the chain head; the RPC may be behind or on another chain",
          details: {
            ahead_blocks: String(-lag),
            tolerance_blocks: String(thresholds.cursorAheadToleranceBlocks),
            ...position,
          },
        });
      }
    }
  }

  // Always a warning: a claim that stays pending is usually an investor who
  // never signed, a support item rather than a platform fault. Whether the
  // platform is at fault is what the watcher alerts above say.
  if (snapshot.pendingOverdue >= thresholds.pendingOverdueAlertCount) {
    alerts.push({
      event: WALLET_REGISTRY_ALERT_EVENTS.pendingOverdue,
      severity: "warn",
      message: "wallet registrations pending beyond approval threshold",
      details: {
        pending_registrations_overdue: snapshot.pendingOverdue,
        pending_total: snapshot.pendingTotal,
        threshold_count: thresholds.pendingOverdueAlertCount,
        oldest_pending_age_seconds:
          snapshot.oldestPendingRequestedAt === null ? null : secondsBetween(now, snapshot.oldestPendingRequestedAt),
      },
    });
  }

  // Level-triggered on purpose: the mismatch itself is announced once, so this
  // is the reminder that one is still open.
  if (snapshot.unresolvedMismatchCount > 0) {
    alerts.push({
      event: WALLET_REGISTRY_ALERT_EVENTS.addressMismatchUnresolved,
      severity: "warn",
      message: "wallet registration address mismatch is still unresolved",
      details: {
        unresolved_count: snapshot.unresolvedMismatchCount,
        account_ids: snapshot.unresolvedMismatchAccountIds,
      },
    });
  }

  return alerts;
}

export interface WalletRegistryRunSignals {
  // Events that matched no pending claim in a block past the previous cursor.
  newUnmatchedEvents: number;
}

/**
 * Alerts for one watcher run, as opposed to the standing health of the
 * watcher. A burst of unknown events in a single run is the signal; a slow
 * trickle across many runs needs a rate over the counter instead.
 */
export function evaluateWalletRegistryRun(
  signals: WalletRegistryRunSignals,
  thresholds: WalletRegistryAlertThresholds,
): WalletRegistryAlert[] {
  if (signals.newUnmatchedEvents < thresholds.unmatchedEventsAlertCount) return [];
  return [
    {
      event: WALLET_REGISTRY_ALERT_EVENTS.unmatchedEvents,
      severity: "warn",
      message: "wallet registry events matched no pending registration",
      details: {
        new_unmatched_events: signals.newUnmatchedEvents,
        threshold_count: thresholds.unmatchedEventsAlertCount,
      },
    },
  ];
}

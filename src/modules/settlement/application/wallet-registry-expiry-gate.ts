import {
  WALLET_REGISTRY_ALERT_EVENTS,
  evaluateWalletRegistryHealth,
  type WalletRegistryAlertThresholds,
} from "../domain/wallet-registry-alert-policy.js";
import type { WalletRegistryHealthReader } from "../repository/wallet-registry-health.repository.js";

// The health policy's verdicts that mean the watcher may not have read every
// registration event yet: it has not completed a run lately (stalled), its
// cursor is far behind the chain (lag), or its cursor is ahead of the head its
// RPC reports (behind, or on another chain). A claim whose event is still
// unread is not abandoned, so none of these lets a claim be expired.
const UNTRUSTED_WATCHER_EVENTS: ReadonlySet<string> = new Set([
  WALLET_REGISTRY_ALERT_EVENTS.watcherStalled,
  WALLET_REGISTRY_ALERT_EVENTS.cursorLag,
  WALLET_REGISTRY_ALERT_EVENTS.cursorAheadOfChain,
]);

export interface WalletRegistryExpiryGateOptions {
  // The same thresholds the health check uses: no new ones (AD-287, decided
  // 2026-11-17).
  thresholds: WalletRegistryAlertThresholds;
  // The registry address is set in this worker. When it is not, the wallet
  // registry is switched off here: no claim can be confirmed, nobody is
  // waiting on a watcher, and the health check does not exist either, so
  // nothing holds the sweep back.
  registryConfigured: boolean;
  // The watcher job exists in this worker: the registry address is set AND the
  // CHAIN_* settings it needs are too. Kept apart from registryConfigured on
  // purpose. A registry address without the watcher is half a configuration
  // (environment.ts supports it, and the health check calls it an error:
  // "pending claims cannot confirm"), and it is what a worker looks like after
  // it lost its CHAIN_* settings. Its cursor is still saved, so the day the
  // watcher resumes it reads every event it missed, and a claim expired in the
  // meantime would see its event counted as unmatched.
  watcherRunnable: boolean;
  // The reading asks for the overdue cutoff; the verdict below does not use
  // it, so this only has to match the health check's.
  pendingOverdueAfterMs: number;
}

/**
 * Whether the registry watcher can be trusted to have read the claims' events,
 * for the claim expiry sweep (AD-287, decided 2026-11-17: the sweep skips while
 * the watcher is stale or lagging).
 *
 * It reads the same snapshot as the health check and runs the same pure policy
 * with the same thresholds, then looks only at the watcher alerts. One thing
 * differs on purpose: the policy starts a stalled watcher's clock at the later
 * of its last run and this worker's start, so that a deploy gets one threshold
 * to complete a run before it pages anyone. That grace must not apply here: a
 * watcher that has been down for hours and a worker that has just restarted
 * would let the first sweep expire every claim it never read. So the worker
 * start is taken as the epoch, and a watcher is stale when its recorded
 * heartbeat is older than the threshold, or there is none.
 *
 * A watcher that cannot run in this worker is judged by its history, not by
 * the fact that it is absent. If the registry address is unset the registry is
 * off and nothing is waited for. If the address is set but the watcher cannot
 * run (CHAIN_* settings missing) the verdict is the stalest one there is: a
 * watcher with any recorded history (a heartbeat row, readable or not, or a
 * saved cursor) has stopped, whatever its heartbeat says, and the sweep waits
 * with reason wallet_registry.watcher_not_configured; only a deployment whose
 * watcher has never run at all, so has no event it could be about to read, is
 * let through.
 *
 * It does not catch: a snapshot that cannot be read rejects, and the sweep
 * treats that as "may not expire".
 */
export class WalletRegistryExpiryGate {
  public constructor(
    private readonly reader: WalletRegistryHealthReader,
    private readonly options: WalletRegistryExpiryGateOptions,
  ) {}

  public async assess(now: Date): Promise<{ mayExpire: boolean; reasons: readonly string[] }> {
    const reading = await this.reader.readWalletRegistryHealth(
      new Date(now.getTime() - this.options.pendingOverdueAfterMs),
    );
    const alerts = evaluateWalletRegistryHealth(
      {
        watcherConfigured: this.options.watcherRunnable,
        workerStartedAt: new Date(0),
        heartbeat: reading.heartbeat,
        pendingTotal: reading.pendingTotal,
        pendingOverdue: reading.pendingOverdue,
        oldestPendingRequestedAt: reading.oldestPendingRequestedAt,
        unresolvedMismatchCount: reading.unresolvedMismatches.count,
        unresolvedMismatchAccountIds: reading.unresolvedMismatches.accountIds,
        flaggedEvidenceCount: reading.flaggedEvidence.count,
        flaggedEvidenceAccountIds: reading.flaggedEvidence.accountIds,
      },
      this.options.thresholds,
      now,
    );
    const reasons: string[] = alerts
      .filter((alert) => UNTRUSTED_WATCHER_EVENTS.has(alert.event))
      .map((alert) => alert.event);
    // The policy raises watcher_not_configured for any watcher that cannot run;
    // it holds the sweep only where the watcher has ever run and the registry is on.
    if (!this.options.watcherRunnable && this.options.registryConfigured && reading.watcherHistoryRecorded) {
      reasons.push(WALLET_REGISTRY_ALERT_EVENTS.watcherNotConfigured);
    }
    return { mayExpire: reasons.length === 0, reasons };
  }
}

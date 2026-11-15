import {
  evaluateWalletRegistryHealth,
  type WalletRegistryAlertThresholds,
} from "../domain/wallet-registry-alert-policy.js";
import type { WalletRegistryHealthReader } from "../repository/wallet-registry-health.repository.js";
import type { WalletRegistryAlertReporter } from "./wallet-registry-alert-reporter.js";

export interface CheckWalletRegistryHealthOptions {
  thresholds: WalletRegistryAlertThresholds;
  // False when the registry address is set but the watcher job cannot run.
  watcherConfigured: boolean;
  // When this worker process started: a stalled watcher is measured from the
  // later of its last run and this, so a deploy gets a grace period.
  workerStartedAt: Date;
  // A claim pending longer than this is "overdue".
  pendingOverdueAfterMs: number;
  clock?: () => Date;
}

/**
 * The scheduled health check of the wallet-registry watcher: reads the
 * heartbeat, the pending claims and the open address mismatches from the
 * database (no RPC, so it still works when the RPC is what is down), applies
 * the pure alert policy and reports the result.
 */
export class CheckWalletRegistryHealthService {
  private readonly clock: () => Date;

  public constructor(
    private readonly reader: WalletRegistryHealthReader,
    private readonly reporter: Pick<WalletRegistryAlertReporter, "reportHealth" | "reportHealthFailure">,
    private readonly options: CheckWalletRegistryHealthOptions,
    private readonly newTraceId: () => string,
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  public async execute(): Promise<void> {
    const traceId = this.newTraceId();
    try {
      const now = this.clock();
      const reading = await this.reader.readWalletRegistryHealth(
        new Date(now.getTime() - this.options.pendingOverdueAfterMs),
      );
      const snapshot = {
        watcherConfigured: this.options.watcherConfigured,
        workerStartedAt: this.options.workerStartedAt,
        heartbeat: reading.heartbeat,
        pendingTotal: reading.pendingTotal,
        pendingOverdue: reading.pendingOverdue,
        oldestPendingRequestedAt: reading.oldestPendingRequestedAt,
        unresolvedMismatchCount: reading.unresolvedMismatches.count,
        unresolvedMismatchAccountIds: reading.unresolvedMismatches.accountIds,
      };
      const alerts = evaluateWalletRegistryHealth(snapshot, this.options.thresholds, now);
      this.reporter.reportHealth(snapshot, alerts, traceId, now);
    } catch (error) {
      throw this.reporter.reportHealthFailure(error, traceId);
    }
  }
}

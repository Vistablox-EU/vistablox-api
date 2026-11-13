import type { Logger } from "pino";

import type { WorkerMetrics } from "../../../shared/health/worker-metrics.js";
import { toSanitizedError } from "../../../shared/logging/log-redaction.js";
import {
  WALLET_REGISTRY_ALERT_EVENTS,
  evaluateWalletRegistryRun,
  walletRegistryCursorLagBlocks,
  type WalletRegistryAlert,
  type WalletRegistryAlertThresholds,
  type WalletRegistryHealthSnapshot,
} from "../domain/wallet-registry-alert-policy.js";
import type { WalletRegistryHeartbeatWriter } from "../repository/wallet-registry-health.repository.js";
import type { ConfirmWalletRegistrationsSummary } from "./confirm-wallet-registrations.service.js";

// A burst of mismatches in one run is capped so a spammer cannot flood the log;
// the rest are counted in the metric and in the single "suppressed" line.
const MAX_MISMATCH_EVENTS_PER_RUN = 20;
const MAX_ERROR_MESSAGE_LENGTH = 500;

const METRIC_PREFIX = "vistablox_worker_wallet_registration";
const METRICS = {
  runs: `${METRIC_PREFIX}_runs_total`,
  failures: `${METRIC_PREFIX}_failures_total`,
  confirmed: `${METRIC_PREFIX}_confirmed_total`,
  unmatchedEvents: `${METRIC_PREFIX}_unmatched_events_total`,
  newUnmatchedEvents: `${METRIC_PREFIX}_new_unmatched_events_total`,
  addressMismatches: `${METRIC_PREFIX}_address_mismatches_total`,
  addressMismatchDuplicates: `${METRIC_PREFIX}_address_mismatch_duplicates_total`,
  heartbeatWriteFailures: `${METRIC_PREFIX}_heartbeat_write_failures_total`,
  healthCheckFailures: `${METRIC_PREFIX}_health_check_failures_total`,
  pendingOverdue: `${METRIC_PREFIX}_pending_overdue`,
  pendingTotal: `${METRIC_PREFIX}_pending_total`,
  heartbeatAgeSeconds: `${METRIC_PREFIX}_watcher_heartbeat_age_seconds`,
  cursorLagBlocks: `${METRIC_PREFIX}_cursor_lag_blocks`,
  unresolvedMismatches: `${METRIC_PREFIX}_address_mismatch_unresolved`,
  alertsActive: `${METRIC_PREFIX}_health_alerts_active`,
} as const;

export interface WalletRegistryAlertReporterOptions {
  logger: Pick<Logger, "info" | "warn" | "error">;
  metrics: Pick<WorkerMetrics, "set" | "increment">;
  heartbeats: WalletRegistryHeartbeatWriter;
  thresholds: WalletRegistryAlertThresholds;
  jobs: { watcher: string; health: string };
  clock?: () => Date;
}

/**
 * Turns what the wallet-registry watcher and its health check observe into
 * structured log events and metrics.
 *
 * Every event line carries `event` (a stable dotted name from
 * WALLET_REGISTRY_ALERT_EVENTS), `severity` ("error" is page-worthy, "warn" is
 * a ticket, "info" is proof of life), `job` and `trace_id`, plus snake_case
 * fields. pino's own `level` is numeric and its message is free text, so an
 * alert rule keys on `event` and `severity`, never on the message.
 *
 * Only identifiers go into a line: account ids, masked values, block numbers
 * as decimal strings. A full wallet address or commitment never does (the
 * audit row keeps those), and no error is logged as an object (a viem error
 * carries the RPC URL, whose path holds the provider's key).
 */
export class WalletRegistryAlertReporter {
  private readonly logger: Pick<Logger, "info" | "warn" | "error">;
  private readonly metrics: Pick<WorkerMetrics, "set" | "increment">;
  private readonly clock: () => Date;

  public constructor(private readonly options: WalletRegistryAlertReporterOptions) {
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Counts a started watcher run; failed runs are counted too. */
  public runStarted(): void {
    this.metrics.increment(METRICS.runs);
  }

  /**
   * One completed watcher run. Never throws: a failure to write the heartbeat
   * is itself reported, and the health check then reports the stall, which is
   * the right operator-visible outcome of a database that will not take writes.
   */
  public async reportRun(
    summary: ConfirmWalletRegistrationsSummary,
    cursorBlock: bigint | null,
    traceId: string,
  ): Promise<void> {
    const job = this.options.jobs.watcher;

    // First: nothing below may stand between a completed run and its heartbeat.
    await this.writeHeartbeat(summary, cursorBlock, traceId);

    this.metrics.set(METRICS.pendingOverdue, summary.pendingRegistrationsOverdue);
    this.metrics.increment(METRICS.confirmed, summary.registrationsConfirmed);
    this.metrics.increment(METRICS.unmatchedEvents, summary.unmatchedEvents);
    this.metrics.increment(METRICS.newUnmatchedEvents, summary.newUnmatchedEvents);
    this.metrics.increment(METRICS.addressMismatches, summary.addressMismatches.length);
    this.metrics.increment(METRICS.addressMismatchDuplicates, summary.addressMismatchesRepeated);

    this.logger.info({ trace_id: traceId, job, ...summary }, "case timer job completed");

    const announced = summary.addressMismatches.slice(0, MAX_MISMATCH_EVENTS_PER_RUN);
    for (const mismatch of announced) {
      this.logger.error(
        {
          event: WALLET_REGISTRY_ALERT_EVENTS.addressMismatch,
          severity: "error",
          job,
          trace_id: traceId,
          account_id: mismatch.accountId,
          commitment_masked: mismatch.commitmentMasked,
          stored_wallet_masked: mismatch.storedWalletMasked,
          on_chain_sender_masked: mismatch.onChainSenderMasked,
        },
        "wallet registration event address mismatch -- possible spoofed registration attempt",
      );
    }
    if (summary.addressMismatches.length > announced.length) {
      this.logger.error(
        {
          event: WALLET_REGISTRY_ALERT_EVENTS.addressMismatch,
          severity: "error",
          job,
          trace_id: traceId,
          suppressed: summary.addressMismatches.length - announced.length,
        },
        "further wallet registration address mismatches in this run were not listed individually",
      );
    }

    for (const alert of evaluateWalletRegistryRun(
      { newUnmatchedEvents: summary.newUnmatchedEvents },
      this.options.thresholds,
    )) {
      this.logAlert(alert, job, traceId);
    }
  }

  /**
   * A failed watcher run. Returns the error to rethrow: a copy with its URLs
   * stripped, because pg-boss stores the thrown error as the job's output and
   * the dead-letter consumer logs it, and a viem error carries the RPC URL.
   */
  public reportFailure(error: unknown, traceId: string): Error {
    this.metrics.increment(METRICS.failures);
    const sanitized = toSanitizedError(error);
    // Warn, not error: one failed run is routine (an RPC blip) and is retried
    // within a minute. A watcher that keeps failing is announced at error level
    // by the health check as watcher_stalled, and a job that exhausts its
    // retries is announced by the dead-letter line.
    this.logger.warn(
      {
        event: WALLET_REGISTRY_ALERT_EVENTS.watcherFailed,
        severity: "warn",
        job: this.options.jobs.watcher,
        trace_id: traceId,
        error_name: sanitized.name,
        error_message: sanitized.message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
        error_stack: sanitized.stack,
      },
      "wallet registry watcher run failed",
    );
    return sanitized;
  }

  /** One health check: a proof-of-life line every time, one line per alert, and the gauges. */
  public reportHealth(
    snapshot: WalletRegistryHealthSnapshot,
    alerts: readonly WalletRegistryAlert[],
    traceId: string,
    now: Date,
  ): void {
    const job = this.options.jobs.health;
    const heartbeat = snapshot.heartbeat;
    const heartbeatAgeSeconds =
      heartbeat === null ? null : Math.max(0, Math.floor((now.getTime() - heartbeat.completedAt.getTime()) / 1000));
    const lag = heartbeat === null ? null : walletRegistryCursorLagBlocks(heartbeat);
    const savedCursor = heartbeat?.cursorBlock ?? null;

    // The anchor for an "absent for N minutes" rule: if this line stops, the
    // check itself (or the whole worker) has stopped.
    this.logger.info(
      {
        event: WALLET_REGISTRY_ALERT_EVENTS.healthChecked,
        severity: "info",
        job,
        trace_id: traceId,
        watcher_configured: snapshot.watcherConfigured,
        heartbeat_age_seconds: heartbeatAgeSeconds,
        cursor_block: savedCursor === null ? null : String(savedCursor),
        safe_head_block: heartbeat === null ? null : String(heartbeat.safeHeadBlock),
        cursor_lag_blocks: lag === null ? null : String(lag),
        pending_total: snapshot.pendingTotal,
        pending_overdue: snapshot.pendingOverdue,
        unresolved_address_mismatches: snapshot.unresolvedMismatchCount,
        alerts_active: alerts.length,
      },
      "wallet registry health checked",
    );
    for (const alert of alerts) this.logAlert(alert, job, traceId);

    this.metrics.set(METRICS.pendingTotal, snapshot.pendingTotal);
    this.metrics.set(METRICS.pendingOverdue, snapshot.pendingOverdue);
    // -1 means no heartbeat has been written yet.
    this.metrics.set(METRICS.heartbeatAgeSeconds, heartbeatAgeSeconds ?? -1);
    this.metrics.set(METRICS.cursorLagBlocks, lag === null ? 0 : Number(lag));
    this.metrics.set(METRICS.unresolvedMismatches, snapshot.unresolvedMismatchCount);
    this.metrics.set(METRICS.alertsActive, alerts.length);
  }

  /** The health check could not run (the database was unreachable, say). Returns the error to rethrow. */
  public reportHealthFailure(error: unknown, traceId: string): Error {
    this.metrics.increment(METRICS.healthCheckFailures);
    const sanitized = toSanitizedError(error);
    this.logger.error(
      {
        event: WALLET_REGISTRY_ALERT_EVENTS.healthCheckFailed,
        severity: "error",
        job: this.options.jobs.health,
        trace_id: traceId,
        error_name: sanitized.name,
        error_message: sanitized.message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
        error_stack: sanitized.stack,
      },
      "wallet registry health check failed",
    );
    return sanitized;
  }

  private logAlert(alert: WalletRegistryAlert, job: string, traceId: string): void {
    this.logger[alert.severity](
      { event: alert.event, severity: alert.severity, job, trace_id: traceId, ...alert.details },
      alert.message,
    );
  }

  private async writeHeartbeat(
    summary: ConfirmWalletRegistrationsSummary,
    cursorBlock: bigint | null,
    traceId: string,
  ): Promise<void> {
    try {
      await this.options.heartbeats.recordWatcherHeartbeat({
        completedAt: this.clock(),
        safeHeadBlock: BigInt(summary.safeHeadBlock),
        cursorBlock,
        eventsFound: summary.eventsFound,
      });
    } catch (error) {
      this.metrics.increment(METRICS.heartbeatWriteFailures);
      const sanitized = toSanitizedError(error);
      this.logger.warn(
        {
          event: WALLET_REGISTRY_ALERT_EVENTS.heartbeatWriteFailed,
          severity: "warn",
          job: this.options.jobs.watcher,
          trace_id: traceId,
          error_name: sanitized.name,
          error_message: sanitized.message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
        },
        "wallet registry watcher heartbeat could not be written; the health check will report a stall",
      );
    }
  }
}

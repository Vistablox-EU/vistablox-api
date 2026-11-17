import type { Logger } from "pino";

import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import { evaluateOnrampLateEvidence } from "../domain/onramp-late-evidence-alert.policy.js";
import type { OnrampLateEvidenceAlertSource } from "../repository/onramp-late-evidence.repository.js";

/** The queue the worker schedules this on; the worker wiring test pins that its literals match. */
export const ONRAMP_LATE_EVIDENCE_ALERT_JOB = "maintenance.onramp_late_evidence_alert";

export interface CheckOnrampLateEvidenceSummary extends JobRunSummary {
  /** Entries nobody has marked reviewed, for the gauge. */
  unreviewed: number;
}

/**
 * The standing alert of AD-288 (decided 2026-11-17): every run, while at least
 * one late onramp evidence entry is unreviewed, one structured warn line with
 * a stable `event` and counts and ids only. It is level-triggered, not a
 * fire-once log: the line comes back every hour until staff mark the last
 * entry reviewed, so an entry written while nobody was looking is still
 * announced. Alert rules key on `event` and `severity`, never on the message
 * (the convention of the wallet registry alerts and of the Coinbase client).
 * It reads the database only, so it runs whether or not Coinbase is
 * configured.
 */
export class CheckOnrampLateEvidenceService {
  public constructor(
    private readonly source: OnrampLateEvidenceAlertSource,
    private readonly logger: Pick<Logger, "warn">,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(traceId: string): Promise<CheckOnrampLateEvidenceSummary> {
    const snapshot = await this.source.unreviewedLateEvidenceSnapshot();
    const alerts = evaluateOnrampLateEvidence(snapshot, this.clock());
    for (const alert of alerts) {
      this.logger.warn(
        { event: alert.event, severity: alert.severity, job: ONRAMP_LATE_EVIDENCE_ALERT_JOB, trace_id: traceId, ...alert.details },
        alert.message,
      );
    }
    return { checked: snapshot.unreviewedCount, acted: alerts.length, unreviewed: snapshot.unreviewedCount };
  }
}

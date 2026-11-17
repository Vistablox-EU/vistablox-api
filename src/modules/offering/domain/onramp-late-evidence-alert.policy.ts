/**
 * The standing alert for late onramp evidence that nobody has marked reviewed
 * (AD-288, decided 2026-11-17). Pure: the snapshot and the clock are inputs,
 * so every boundary is pinned by a table test.
 *
 * Level-triggered on purpose, like the wallet registry's unresolved-mismatch
 * reminder (AD-284's pattern for flagged evidence): the entry itself is
 * written once, so a fire-once log line would be the only notice and would be
 * lost with the first rotation of the log. This is raised on every check
 * while at least one entry is unreviewed, and stops when the last one is
 * marked reviewed. "warn" is a ticket, not a page: the EURC is already in the
 * investor's wallet and nothing time-critical happens to it.
 */

/** The stable event name an alert rule keys on. Renaming it breaks every rule built on it. */
export const ONRAMP_LATE_EVIDENCE_ALERT_EVENTS = {
  unreviewed: "offering.onramp_late_evidence_unreviewed",
} as const;

export type OnrampLateEvidenceAlertEvent =
  (typeof ONRAMP_LATE_EVIDENCE_ALERT_EVENTS)[keyof typeof ONRAMP_LATE_EVIDENCE_ALERT_EVENTS];

/** The most evidence ids one alert line lists; the count always says how many there are. */
export const MAX_ALERT_EVIDENCE_IDS = 20;

export interface OnrampLateEvidenceSnapshot {
  unreviewedCount: number;
  /** observed_at of the oldest unreviewed entry; null when there is none. */
  oldestObservedAt: Date | null;
  /** Ids of the oldest unreviewed entries, oldest first; may be shorter than the count. */
  oldestEvidenceIds: readonly string[];
}

export interface OnrampLateEvidenceAlert {
  event: OnrampLateEvidenceAlertEvent;
  severity: "warn";
  message: string;
  // Counts and ids only. Never a wallet address, a transaction hash or an
  // amount: the list itself (staff only) is where those are read.
  details: Readonly<Record<string, number | readonly string[]>>;
}

export function evaluateOnrampLateEvidence(snapshot: OnrampLateEvidenceSnapshot, now: Date): OnrampLateEvidenceAlert[] {
  if (snapshot.unreviewedCount <= 0) return [];
  const listed = snapshot.oldestEvidenceIds.slice(0, MAX_ALERT_EVIDENCE_IDS);
  return [
    {
      event: ONRAMP_LATE_EVIDENCE_ALERT_EVENTS.unreviewed,
      severity: "warn",
      message: "late onramp funding evidence is waiting for a staff review",
      details: {
        unreviewed_count: snapshot.unreviewedCount,
        oldest_unreviewed_age_seconds:
          snapshot.oldestObservedAt === null
            ? 0
            : Math.max(0, Math.floor((now.getTime() - snapshot.oldestObservedAt.getTime()) / 1000)),
        evidence_ids: listed,
        evidence_ids_listed: listed.length,
      },
    },
  ];
}

import type { ConfirmWalletRegistrationsSummary } from "../../src/modules/settlement/application/confirm-wallet-registrations.service.js";

/**
 * The counters chain evidence added to the watcher's summary (replays, events
 * without an identity, conflicting events, evidence recorded, refreshed,
 * re-checked, verified and flagged, the rewound cursor), all quiet. The
 * alerting suites build summaries of their own and are not about these.
 */
export const QUIET_EVIDENCE_COUNTERS = {
  eventsReplayed: 0,
  eventsWithoutIdentity: 0,
  conflictingEvents: 0,
  evidenceRecorded: 0,
  evidenceRefreshed: 0,
  evidenceRefreshDeferred: 0,
  evidenceRechecked: 0,
  evidenceVerified: 0,
  evidenceFlagged: 0,
  evidenceRecheckErrors: 0,
  cursorRewoundTo: null,
} satisfies Partial<ConfirmWalletRegistrationsSummary>;

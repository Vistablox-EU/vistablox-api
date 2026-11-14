import type { ConfirmWalletRegistrationsSummary } from "../../src/modules/settlement/application/confirm-wallet-registrations.service.js";

/**
 * The counters the claim lifecycle (stale and conflicting confirmations) and
 * the chain evidence (replays, refreshes, re-checks, the rewound cursor) added
 * to the watcher's summary, all quiet. The alerting suites build summaries of
 * their own and are not about these.
 */
export const QUIET_CLAIM_AND_EVIDENCE_COUNTERS = {
  staleConfirmations: 0,
  confirmationConflicts: 0,
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

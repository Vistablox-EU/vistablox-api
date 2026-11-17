import type { JobQueueKind } from "./job-queues.js";

/**
 * Who answers for a queue's dead-lettered jobs, and how fast. The owner is an
 * area of the codebase, not a person: phase 1 has no on-call rotation
 * (AD-089), so mapping an owner to a person or channel is a founder decision
 * (docs/dead-letter-jobs.md). Tier follows AD-090: anything touching
 * settlement/money, investor rights, or account security is tier_1.
 */
export type JobOwner = "settlement" | "payments" | "offering" | "intake" | "identity" | "platform";

export type JobAlertTier = "tier_1" | "tier_2";

export type JobQueueOwnership = {
  kind: JobQueueKind;
  owner: JobOwner;
  tier: JobAlertTier;
};

// Every queue the API and the worker create with ensureJobQueue. A test keeps
// this in step with server.ts and worker.ts, so a new queue cannot ship
// without an owner.
export const JOB_QUEUE_OWNERSHIP: Readonly<Record<string, JobQueueOwnership>> = {
  "case_timers.applicant_reminders": { kind: "scheduled", owner: "intake", tier: "tier_2" },
  "case_timers.response_window_expiry": { kind: "scheduled", owner: "intake", tier: "tier_2" },
  "case_timers.pre_offering_open_handoff": { kind: "event", owner: "offering", tier: "tier_2" },
  "case_timers.post_ipo_structuring_handoff": { kind: "event", owner: "intake", tier: "tier_2" },
  "case_timers.reservation_unfunded_expiry": { kind: "scheduled", owner: "payments", tier: "tier_1" },
  "case_timers.reservation_onramp_poll": { kind: "scheduled", owner: "payments", tier: "tier_1" },
  "case_timers.offering_reconfirmation_window_close": { kind: "scheduled", owner: "offering", tier: "tier_1" },
  "case_timers.offering_reconfirmation_reminders": { kind: "scheduled", owner: "offering", tier: "tier_2" },
  "case_timers.offering_reconfirmation_window_opened": { kind: "event", owner: "offering", tier: "tier_1" },
  "rental.operating_distribution_sweep": { kind: "scheduled", owner: "settlement", tier: "tier_1" },
  "settlement.open_ipo_escrow_campaign": { kind: "event", owner: "settlement", tier: "tier_1" },
  "settlement.finalize_ipo_escrow_campaigns": { kind: "scheduled", owner: "settlement", tier: "tier_1" },
  "settlement.confirm_wallet_registrations": { kind: "scheduled", owner: "settlement", tier: "tier_1" },
  "settlement.check_wallet_registry_health": { kind: "scheduled", owner: "settlement", tier: "tier_1" },
  "provider_events.coinbase_onramp_webhook": { kind: "event", owner: "payments", tier: "tier_1" },
  "provider_events.didit_webhook": { kind: "event", owner: "identity", tier: "tier_1" },
  "maintenance.kyc_renewal": { kind: "scheduled", owner: "identity", tier: "tier_2" },
  "maintenance.kyc_stuck_session_expiry": { kind: "scheduled", owner: "identity", tier: "tier_2" },
  "maintenance.kyc_stuck_session_reconciliation": { kind: "scheduled", owner: "identity", tier: "tier_2" },
  "maintenance.account_recovery_alert": { kind: "scheduled", owner: "identity", tier: "tier_1" },
  "maintenance.onramp_late_evidence_alert": { kind: "scheduled", owner: "payments", tier: "tier_1" },
  "maintenance.dpop_replay_prune": { kind: "scheduled", owner: "platform", tier: "tier_2" },
  "maintenance.device_challenge_prune": { kind: "scheduled", owner: "platform", tier: "tier_2" },
  "maintenance.signing_request_prune": { kind: "scheduled", owner: "platform", tier: "tier_2" },
};

/**
 * An unknown queue (a legacy entry with no source, or a queue added without an
 * entry above) fails loud: platform owns it at tier_1.
 */
export function ownershipOf(queueName: string): JobQueueOwnership & { known: boolean } {
  const ownership = Object.hasOwn(JOB_QUEUE_OWNERSHIP, queueName) ? JOB_QUEUE_OWNERSHIP[queueName] : undefined;
  return ownership === undefined
    ? { kind: "event", owner: "platform", tier: "tier_1", known: false }
    : { ...ownership, known: true };
}

import { randomUUID } from "node:crypto";

import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import type { DiditClient } from "./didit-client.js";
import { evaluateDiditOutcome, type DiditStatus } from "../domain/kyc-policy.js";
import { evaluateProofOfAddressOutcome } from "../domain/proof-of-address-policy.js";
import { isSessionStuck } from "../domain/stuck-session.policy.js";
import type { KycRepository } from "../repository/kyc.repository.js";

// Nothing user-facing happens between reserveSessionStart and
// completeSessionStart/failSessionStart — they run back to back within the
// same request — so anything beyond a few minutes here is a crash, never a
// legitimately slow one. Matches case_timers.reservation_unfunded_expiry's
// own 15-minute reasoning style for an analogous "this should resolve in
// seconds, so minutes means something went wrong" window.
const CREATING_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * docs/didit-kyc.md's stuck-session-start gap, timeout half: a crash (or a
 * completeSessionStart/completeProofOfAddressSessionStart persistence
 * failure — see the StartKycSessionService fix this shipped alongside)
 * between reserving a session start and completing or failing it leaves the
 * row at kyc_session_creating/creating forever, a substatus
 * canStartSession/canStartProofOfAddress both exclude from retry. No live
 * Didit reference is ever recorded at this stage (completeSessionStart is
 * what sets it), so there is nothing to reconcile against — failing the
 * attempt outright is the only, and correct, recovery: it lands on
 * kyc_session_creation_failed, which *is* in the retry allow-list.
 */
export class ExpireStuckSessionCreationsService {
  public constructor(
    private readonly repository: KycRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(traceId: string): Promise<JobRunSummary> {
    const now = this.clock();
    const stuck = await this.repository.listStuckSessionCreationsForTimer();

    let acted = 0;
    for (const session of stuck) {
      const due = isSessionStuck({ updatedAt: session.updatedAt, now, timeoutMs: CREATING_TIMEOUT_MS });
      if (!due) continue;
      if (session.kind === "baseline") {
        await this.repository.failSessionStart({
          accountId: session.accountId,
          sessionStartId: session.sessionStartId,
          traceId,
          failedAt: now,
        });
      } else {
        await this.repository.failProofOfAddressSessionStart({
          accountId: session.accountId,
          sessionStartId: session.sessionStartId,
          traceId,
          failedAt: now,
        });
      }
      acted += 1;
    }
    return { checked: stuck.length, acted };
  }
}

// A live Didit session genuinely exists at this stage (unlike the
// *_creating case above) and the customer may still be actively completing
// it — a baseline verification flow (ID capture, liveness, face match)
// normally finishes in minutes, so an hour is already generous headroom
// before the first re-check, not a "give up" cutoff: a session found still
// genuinely pending is simply left alone and re-checked on the next run.
const OPEN_RECONCILIATION_THRESHOLD_MS = 60 * 60 * 1000;

// Statuses evaluateStatusOutcome/evaluateProofOfAddressOutcome both treat as
// "nothing new to report" — re-querying Didit and finding one of these back
// means the session is still exactly where it was, so there is nothing to
// apply (and calling applyProviderOutcome anyway would just write a
// same-effect audit/history row for no reason).
const STILL_PENDING_STATUSES: ReadonlySet<DiditStatus> = new Set(["Not Started", "In Progress", "Awaiting User"]);

/**
 * docs/didit-kyc.md's stuck-session-start gap, reconciliation half: the
 * webhook is the *only* mechanism that ever advances kyc_session_open/
 * in_progress (case_timers.reservation_onramp_poll has no KYC equivalent
 * today) — if Didit's own Expired/Abandoned webhook is ever lost in
 * transit, or VistaBlox never receives it, the row is stuck forever with no
 * other path forward. This re-queries Didit's own decision endpoint
 * (DiditClient.getDecision, the same one ProcessDiditWebhookService already
 * calls for decision-bearing webhook statuses) for whatever it currently
 * reports, and — only when that is no longer one of the still-pending
 * statuses above — applies it through the exact same
 * evaluateDiditOutcome/evaluateProofOfAddressOutcome + applyProviderOutcome/
 * applyProofOfAddressOutcome pipeline the webhook path already uses. No new
 * policy is introduced: this only makes sure VistaBlox eventually learns
 * what Didit already knows, even when its webhook delivery failed.
 */
export class ReconcileStuckOpenSessionsService {
  public constructor(
    private readonly repository: KycRepository,
    private readonly didit: DiditClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(traceId: string): Promise<JobRunSummary> {
    const now = this.clock();
    const stuck = await this.repository.listStuckOpenSessionsForTimer();

    let acted = 0;
    for (const session of stuck) {
      const due = isSessionStuck({
        updatedAt: session.updatedAt,
        now,
        timeoutMs: OPEN_RECONCILIATION_THRESHOLD_MS,
      });
      if (!due) continue;

      const decision = await this.didit.getDecision(session.diditReference);
      if (decision.status === null || STILL_PENDING_STATUSES.has(decision.status)) continue;

      const eventKey = `didit:reconciliation:${randomUUID()}`;
      const eventId = randomUUID();
      if (session.kind === "baseline") {
        await this.repository.applyProviderOutcome({
          eventKey,
          eventId,
          diditReference: session.diditReference,
          providerStatus: decision.status,
          webhookType: "reconciliation_poll",
          traceId,
          providerUpdatedAt: now,
          outcome: evaluateDiditOutcome({
            status: decision.status,
            decision,
            residenceCountryCode: session.residenceCountryCode,
            taxResidenceCountryCode: session.taxResidenceCountryCode,
            everRequiredManualReview: session.everRequiredManualReview,
            occurredAt: now,
          }),
        });
      } else {
        await this.repository.applyProofOfAddressOutcome({
          eventKey,
          eventId,
          diditReference: session.diditReference,
          providerStatus: decision.status,
          webhookType: "reconciliation_poll",
          traceId,
          providerUpdatedAt: now,
          outcome: evaluateProofOfAddressOutcome({
            status: decision.status,
            decision,
            residenceCountryCode: session.residenceCountryCode,
            occurredAt: now,
          }),
        });
      }
      acted += 1;
    }
    return { checked: stuck.length, acted };
  }
}

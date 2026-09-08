import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError } from "../../../shared/errors/app-error.js";
import type { DiditClient } from "./didit-client.js";
import { evaluateDiditOutcome, type DiditStatus } from "../domain/kyc-policy.js";
import {
  evaluateProofOfAddressOutcome,
  type ProofOfAddressStatus,
} from "../domain/proof-of-address-policy.js";
import type { KycEligibilityRecord, KycRepository } from "../repository/kyc.repository.js";

export class StartKycSessionService {
  public constructor(
    private readonly repository: KycRepository,
    private readonly didit: DiditClient,
    private readonly configuration: { workflowId: string; callbackUrl: string },
    private readonly clock: () => Date = () => new Date(),
    private readonly invalidateDisplayProfile: (accountId: string) => Promise<void> =
      async () => {},
  ) {}

  public async execute(input: {
    accountId: string;
    traceId: string;
    residenceCountryCode: string;
    taxResidenceCountryCode: string;
    language?: string;
  }) {
    const sessionStartId = `kyc_start_${randomUUID()}`;
    const reserved = await this.repository.reserveSessionStart({
      accountId: input.accountId,
      sessionStartId,
      residenceCountryCode: input.residenceCountryCode,
      taxResidenceCountryCode: input.taxResidenceCountryCode,
      traceId: input.traceId,
      startedAt: this.clock(),
    });
    if (!reserved) throw sessionUnavailableError();

    let session: Awaited<ReturnType<DiditClient["createSession"]>>;
    try {
      session = await this.didit.createSession({
        workflowId: this.configuration.workflowId,
        accountId: input.accountId,
        callbackUrl: this.configuration.callbackUrl,
        sessionStartId,
        purpose: "baseline_kyc",
        ...(input.language === undefined ? {} : { language: input.language }),
      });
    } catch (error) {
      await this.repository.failSessionStart({
        accountId: input.accountId,
        sessionStartId,
        traceId: input.traceId,
        failedAt: this.clock(),
      });
      throw error;
    }
    if (
      session.vendorData !== input.accountId ||
      session.workflowId !== this.configuration.workflowId ||
      session.status !== "Not Started"
    ) {
      await this.repository.failSessionStart({
        accountId: input.accountId,
        sessionStartId,
        traceId: input.traceId,
        failedAt: this.clock(),
      });
      throw new AppError({
        code: "identity.kyc_provider_response_invalid",
        title: "Identity verification unavailable",
        status: 502,
        detail: "The identity verification provider returned an invalid response.",
      });
    }

    const completed = await this.repository.completeSessionStart({
      accountId: input.accountId,
      sessionStartId,
      diditReference: session.sessionId,
      providerStatus: session.status,
      traceId: input.traceId,
      completedAt: this.clock(),
    });
    if (!completed) {
      // A live Didit session already exists at this point (created above) —
      // without this, the row is left at kyc_session_creating, a substatus
      // canStartSession's retry allow-list excludes, permanently blocking
      // the customer from ever retrying (there is no other recovery path
      // today). Mirrors the createSession catch block above: attempt the
      // same recovery regardless of why completeSessionStart's own guarded
      // update matched no rows.
      await this.repository.failSessionStart({
        accountId: input.accountId,
        sessionStartId,
        traceId: input.traceId,
        failedAt: this.clock(),
      });
      throw new AppError({
        code: "identity.kyc_session_persistence_failed",
        title: "Identity verification session unavailable",
        status: 500,
        detail: "The created identity verification session could not be activated.",
      });
    }
    await this.invalidateDisplayProfile(input.accountId).catch(() => undefined);
    return {
      data: {
        verification_session_id: session.sessionId,
        verification_url: session.verificationUrl,
        eligibility_state: "not_started" as const,
      },
    };
  }
}

export class GetKycStatusService {
  public constructor(
    private readonly repository: KycRepository,
    private readonly didit: DiditClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(accountId: string) {
    const record = await this.repository.getForAccount(accountId);
    return {
      data: {
        eligibility_state: record?.eligibilityState ?? "not_started",
        proof_of_address_status: resolveProofOfAddressStatus(record, this.clock()),
        proof_of_address_current_until:
          record?.proofOfAddressCurrentUntil?.toISOString() ?? null,
        last_verified_at: record?.lastVerifiedAt?.toISOString() ?? null,
        renewal_due_at: record?.renewalDueAt?.toISOString() ?? null,
        active_session: await this.resolveActiveSession(record),
      },
    };
  }

  // Never persisted (docs/didit-kyc.md's data boundary explicitly excludes
  // session tokens), so a mobile client that needs to resume an in-progress
  // verification is handed a freshly re-fetched one instead: cheap for the
  // common case (most accounts aren't mid-session, so hasOpenSession skips
  // the Didit call entirely), and self-correcting if Didit's own status has
  // already moved past "still open" by the time this is read (no active
  // session is reported rather than a stale/dead link) -- eligibility_state
  // catches up separately, through the existing webhook/reconciliation
  // path, unaffected by this read-only lookup.
  private async resolveActiveSession(record: KycEligibilityRecord | null) {
    if (record === null || record.diditReference === null) return null;
    if (!hasOpenSession(record.operationalSubstatus)) return null;

    const decision = await this.didit.getDecision(record.diditReference).catch(() => null);
    if (decision === null || decision.verificationUrl == null) return null;
    if (decision.status === null || !RESUMABLE_DIDIT_STATUSES.has(decision.status)) return null;

    return {
      verification_session_id: record.diditReference,
      verification_url: decision.verificationUrl,
      expires_at: decision.expiresAt?.toISOString() ?? null,
    };
  }
}

const RESUMABLE_DIDIT_STATUSES: ReadonlySet<DiditStatus> = new Set([
  "Not Started",
  "In Progress",
  "Resubmitted",
]);

function hasOpenSession(substatus: KycEligibilityRecord["operationalSubstatus"]): boolean {
  return (
    substatus === "kyc_session_open" ||
    substatus === "kyc_pending" ||
    substatus === "kyc_resubmission_pending"
  );
}

// Operations-only lookup for authorized reviewers (admin_operations +
// staff WebAuthn, enforced at the router). Unlike GetKycStatusService
// above — which always answers for the caller's own, guaranteed-to-exist
// account, defaulting a missing record to "not_started" — this is a
// lookup by an arbitrary staff-supplied account_id, so a missing record
// is reported as 404 rather than silently rendered as a plausible-looking
// "not started" account that might just be a typo.
export class GetKycAccountForOperationsService {
  public constructor(
    private readonly repository: KycRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(accountId: string) {
    const record = await this.repository.getForAccount(accountId);
    if (record === null) throw kycAccountNotFoundError();
    return {
      data: {
        account_id: record.accountId,
        eligibility_state: record.eligibilityState,
        operational_substatus: record.operationalSubstatus,
        didit_reference: record.diditReference,
        residence_country_code: record.residenceCountryCode,
        tax_residence_country_code: record.taxResidenceCountryCode,
        proof_of_address_status: resolveProofOfAddressStatus(record, this.clock()),
        proof_of_address_didit_reference: record.proofOfAddressDiditReference,
        proof_of_address_provider_status: record.proofOfAddressProviderStatus,
        proof_of_address_provider_updated_at:
          record.proofOfAddressProviderUpdatedAt?.toISOString() ?? null,
        proof_of_address_current_until:
          record.proofOfAddressCurrentUntil?.toISOString() ?? null,
        last_verified_at: record.lastVerifiedAt?.toISOString() ?? null,
        ever_required_manual_review: record.everRequiredManualReview,
        renewal_due_at: record.renewalDueAt?.toISOString() ?? null,
      },
    };
  }
}

function resolveProofOfAddressStatus(
  record: KycEligibilityRecord | null,
  now: Date,
): ProofOfAddressStatus {
  return record?.proofOfAddressStatus === "current" &&
    record.proofOfAddressCurrentUntil !== null &&
    record.proofOfAddressCurrentUntil <= now
    ? "expired"
    : record?.proofOfAddressStatus ?? "not_started";
}

function kycAccountNotFoundError(): AppError {
  return new AppError({
    code: "identity.kyc_account_not_found",
    title: "KYC record not found",
    status: 404,
    detail: "No KYC eligibility record was found for that account.",
  });
}

export class StartProofOfAddressSessionService {
  public constructor(
    private readonly repository: KycRepository,
    private readonly didit: DiditClient,
    private readonly configuration: { workflowId: string; callbackUrl: string },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    traceId: string;
    language?: string;
  }) {
    const sessionStartId = `poa_start_${randomUUID()}`;
    const reserved = await this.repository.reserveProofOfAddressSessionStart({
      accountId: input.accountId,
      sessionStartId,
      traceId: input.traceId,
      startedAt: this.clock(),
    });
    if (!reserved) throw proofOfAddressSessionUnavailableError();

    let session: Awaited<ReturnType<DiditClient["createSession"]>>;
    try {
      session = await this.didit.createSession({
        workflowId: this.configuration.workflowId,
        accountId: input.accountId,
        callbackUrl: this.configuration.callbackUrl,
        sessionStartId,
        purpose: "owner_proof_of_address",
        ...(input.language === undefined ? {} : { language: input.language }),
      });
    } catch (error) {
      await this.repository.failProofOfAddressSessionStart({
        accountId: input.accountId,
        sessionStartId,
        traceId: input.traceId,
        failedAt: this.clock(),
      });
      throw error;
    }
    if (
      session.vendorData !== input.accountId ||
      session.workflowId !== this.configuration.workflowId ||
      session.status !== "Not Started"
    ) {
      await this.repository.failProofOfAddressSessionStart({
        accountId: input.accountId,
        sessionStartId,
        traceId: input.traceId,
        failedAt: this.clock(),
      });
      throw invalidProviderResponseError();
    }

    const completed = await this.repository.completeProofOfAddressSessionStart({
      accountId: input.accountId,
      sessionStartId,
      diditReference: session.sessionId,
      providerStatus: session.status,
      traceId: input.traceId,
      completedAt: this.clock(),
    });
    if (!completed) {
      throw new AppError({
        code: "identity.proof_of_address_session_persistence_failed",
        title: "Proof of address session unavailable",
        status: 500,
        detail: "The created proof of address session could not be activated.",
      });
    }
    return {
      data: {
        verification_session_id: session.sessionId,
        verification_url: session.verificationUrl,
        proof_of_address_status: "in_progress" as const,
      },
    };
  }
}

/**
 * AD-062 / ASYNC_JOBS.md's Webhook Handling Rule: the Express handler's
 * whole job is verify, durably receive, and acknowledge fast — it must not
 * run heavy business orchestration inline. This is that fast path: it does
 * no provider calls and no policy evaluation, only a durable enqueue
 * (KycRepository.enqueueDiditWebhookProcessing) of the already
 * signature-verified, schema-validated body. ProcessDiditWebhookService
 * below — unchanged in its own logic — is now the consumer of the job this
 * enqueues (provider_events.didit_webhook), processed by the standalone KYC
 * service (src/kyc-server.ts), not this API or its worker.
 */
export class ReceiveDiditWebhookService {
  public constructor(private readonly repository: KycRepository) {}

  public async execute(input: {
    eventId: string;
    webhookType: string;
    applicationId: string;
    environment: string;
    sessionId: string;
    sessionKind: string | null;
    workflowId: string | null;
    vendorData: string | null;
    status: string;
    createdAt: number;
    traceId: string;
  }): Promise<{ received: true }> {
    await this.repository.enqueueDiditWebhookProcessing(input);
    return { received: true };
  }
}

// The job payload shape ReceiveDiditWebhookService enqueues
// (provider_events.didit_webhook). Parsed defensively here since a pg-boss
// payload is untyped JSON once round-tripped through Postgres — the same
// pattern openOfferingForApprovedCaseJobSchema already uses. Field names
// and shape deliberately match this service's own long-standing execute()
// input exactly, so every existing direct-call test of this service (built
// when it was still the synchronous webhook handler itself) keeps working
// unchanged against the new job-payload entry point.
export const processDiditWebhookJobSchema = z.object({
  eventId: z.string(),
  webhookType: z.string(),
  applicationId: z.string(),
  environment: z.string(),
  sessionId: z.string(),
  sessionKind: z.string().nullable(),
  workflowId: z.string().nullable(),
  vendorData: z.string().nullable(),
  status: z.string(),
  createdAt: z.number(),
  traceId: z.string(),
});

export class ProcessDiditWebhookService {
  public constructor(
    private readonly repository: KycRepository,
    private readonly didit: DiditClient,
    private readonly configuration: {
      workflowId: string;
      applicationId: string;
      environment: "sandbox" | "live";
      proofOfAddressWorkflowId?: string;
    },
    private readonly invalidateDisplayProfile: (accountId: string) => Promise<void> =
      async () => {},
  ) {}

  public async execute(payload: unknown) {
    const input = processDiditWebhookJobSchema.parse(payload);
    const eventKey = `didit:webhook:${input.eventId}`;
    if (await this.repository.hasProcessedProviderEvent(eventKey)) {
      return { received: true as const, duplicate: true as const };
    }
    const receivedAt = new Date(input.createdAt * 1_000);
    const purpose =
      input.workflowId === this.configuration.workflowId
        ? "baseline_kyc"
        : this.configuration.proofOfAddressWorkflowId !== undefined &&
            input.workflowId === this.configuration.proofOfAddressWorkflowId
          ? "owner_proof_of_address"
          : null;
    if (
      input.applicationId !== this.configuration.applicationId ||
      input.environment !== this.configuration.environment ||
      purpose === null ||
      input.sessionKind === "business" ||
      !["status.updated", "data.updated"].includes(input.webhookType)
    ) {
      await this.repository.recordUnmatchedProviderEvent({
        eventKey,
        eventId: input.eventId,
        diditReference: input.sessionId,
        providerStatus: input.status,
        webhookType: input.webhookType,
        traceId: input.traceId,
        receivedAt,
        reason: "configuration_mismatch",
      });
      return { received: true as const, ignored: true as const };
    }

    const target =
      purpose === "baseline_kyc"
        ? await this.repository.findByDiditReference(input.sessionId)
        : await this.repository.findByProofOfAddressDiditReference(input.sessionId);
    if (target === null) {
      await this.repository.recordUnmatchedProviderEvent({
        eventKey,
        eventId: input.eventId,
        diditReference: input.sessionId,
        providerStatus: input.status,
        webhookType: input.webhookType,
        traceId: input.traceId,
        receivedAt,
        reason: "session_not_found",
      });
      return { received: true as const, ignored: true as const };
    }
    if (input.vendorData !== target.accountId) {
      await this.repository.recordUnmatchedProviderEvent({
        eventKey,
        eventId: input.eventId,
        diditReference: input.sessionId,
        providerStatus: input.status,
        webhookType: input.webhookType,
        traceId: input.traceId,
        receivedAt,
        reason: "correlation_mismatch",
      });
      return { received: true as const, ignored: true as const };
    }
    if (purpose === "baseline_kyc") {
      await this.invalidateDisplayProfile(target.accountId).catch(() => undefined);
    }

    const status = asDiditStatus(input.status);
    const decision = shouldFetchDecision(status)
      ? await this.didit.getDecision(input.sessionId)
      : null;
    if (
      decision !== null &&
      (decision.sessionId !== input.sessionId ||
        decision.sessionKind === "business" ||
        decision.vendorData !== target.accountId ||
        (decision.workflowId !== null &&
          decision.workflowId !== input.workflowId) ||
        decision.status !== status)
    ) {
      await this.repository.recordUnmatchedProviderEvent({
        eventKey,
        eventId: input.eventId,
        diditReference: input.sessionId,
        providerStatus: input.status,
        webhookType: input.webhookType,
        traceId: input.traceId,
        receivedAt,
        reason: "correlation_mismatch",
      });
      return { received: true as const, ignored: true as const };
    }

    const result =
      purpose === "baseline_kyc"
        ? await this.repository.applyProviderOutcome({
            eventKey,
            eventId: input.eventId,
            diditReference: input.sessionId,
            providerStatus: status,
            webhookType: input.webhookType,
            traceId: input.traceId,
            providerUpdatedAt: receivedAt,
            outcome: evaluateDiditOutcome({
              status,
              decision,
              residenceCountryCode: target.residenceCountryCode,
              taxResidenceCountryCode: target.taxResidenceCountryCode,
              everRequiredManualReview: target.everRequiredManualReview,
              occurredAt: receivedAt,
            }),
          })
        : await this.repository.applyProofOfAddressOutcome({
            eventKey,
            eventId: input.eventId,
            diditReference: input.sessionId,
            providerStatus: status,
            webhookType: input.webhookType,
            traceId: input.traceId,
            providerUpdatedAt: receivedAt,
            outcome: evaluateProofOfAddressOutcome({
              status,
              decision,
              residenceCountryCode: target.residenceCountryCode,
              occurredAt: receivedAt,
            }),
          });
    return {
      received: true as const,
      ...(result === "duplicate" ? { duplicate: true as const } : {}),
      ...(result === "stale" ? { stale: true as const } : {}),
      ...(result === "unmatched" ? { ignored: true as const } : {}),
    };
  }
}

function asDiditStatus(value: string): DiditStatus | null {
  const known: DiditStatus[] = [
    "Not Started",
    "In Progress",
    "In Review",
    "Approved",
    "Declined",
    "Resubmitted",
    "Expired",
    "Abandoned",
    "Kyc Expired",
    "Awaiting User",
  ];
  return known.find((status) => status === value) ?? null;
}

function shouldFetchDecision(status: DiditStatus | null): boolean {
  return (
    status === "Approved" ||
    status === "Declined" ||
    status === "In Review" ||
    status === "Abandoned"
  );
}

function sessionUnavailableError(): AppError {
  return new AppError({
    code: "identity.kyc_session_unavailable",
    title: "Identity verification session unavailable",
    status: 409,
    detail: "This account cannot start another identity verification session right now.",
  });
}

function proofOfAddressSessionUnavailableError(): AppError {
  return new AppError({
    code: "identity.proof_of_address_session_unavailable",
    title: "Proof of address session unavailable",
    status: 409,
    detail:
      "This account cannot start another proof of address session right now.",
  });
}

function invalidProviderResponseError(): AppError {
  return new AppError({
    code: "identity.kyc_provider_response_invalid",
    title: "Identity verification unavailable",
    status: 502,
    detail: "The identity verification provider returned an invalid response.",
  });
}

import { randomUUID } from "node:crypto";

import { AppError } from "../../../shared/errors/app-error.js";
import type { DiditClient } from "./didit-client.js";
import { evaluateDiditOutcome, type DiditStatus } from "../domain/kyc-policy.js";
import { evaluateProofOfAddressOutcome } from "../domain/proof-of-address-policy.js";
import type { KycRepository } from "../repository/kyc.repository.js";

export class StartKycSessionService {
  public constructor(
    private readonly repository: KycRepository,
    private readonly didit: DiditClient,
    private readonly configuration: { workflowId: string; callbackUrl: string },
    private readonly clock: () => Date = () => new Date(),
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
      throw new AppError({
        code: "identity.kyc_session_persistence_failed",
        title: "Identity verification session unavailable",
        status: 500,
        detail: "The created identity verification session could not be activated.",
      });
    }
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
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(accountId: string) {
    const record = await this.repository.getForAccount(accountId);
    const proofOfAddressStatus =
      record?.proofOfAddressStatus === "current" &&
      record.proofOfAddressCurrentUntil !== null &&
      record.proofOfAddressCurrentUntil <= this.clock()
        ? "expired"
        : record?.proofOfAddressStatus ?? "not_started";
    return {
      data: {
        eligibility_state: record?.eligibilityState ?? "not_started",
        proof_of_address_status: proofOfAddressStatus,
        proof_of_address_current_until:
          record?.proofOfAddressCurrentUntil?.toISOString() ?? null,
        last_verified_at: record?.lastVerifiedAt?.toISOString() ?? null,
        renewal_due_at: record?.renewalDueAt?.toISOString() ?? null,
      },
    };
  }
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
  ) {}

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
  }) {
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

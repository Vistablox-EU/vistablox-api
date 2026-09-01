import { describe, expect, it, vi } from "vitest";

import type { DiditClient } from "../src/modules/identity/application/didit-client.js";
import {
  ProcessDiditWebhookService,
  StartKycSessionService,
} from "../src/modules/identity/application/kyc.service.js";
import type { KycRepository } from "../src/modules/identity/repository/kyc.repository.js";

const accountId = "acct_01";
const sessionId = "c2237bc6-a76c-4933-b329-6c81843b45c7";
const workflowId = "269214fe-77f7-4b1a-a028-b70e861d73c1";
const applicationId = "c5f501a8-0a32-42cd-ac24-13d0d0b15699";
const now = new Date("2026-09-01T12:00:00.000Z");

function repository(overrides: Partial<KycRepository> = {}): KycRepository {
  return {
    getForAccount: vi.fn().mockResolvedValue(null),
    findByDiditReference: vi.fn().mockResolvedValue({
      accountId,
      diditReference: sessionId,
      eligibilityState: "not_started",
      operationalSubstatus: "kyc_session_open",
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "HR",
      proofOfAddressCurrentUntil: null,
      lastVerifiedAt: null,
      renewalDueAt: null,
    }),
    hasProcessedProviderEvent: vi.fn().mockResolvedValue(false),
    reserveSessionStart: vi.fn().mockResolvedValue(true),
    completeSessionStart: vi.fn().mockResolvedValue(true),
    failSessionStart: vi.fn().mockResolvedValue(undefined),
    applyProviderOutcome: vi.fn().mockResolvedValue("applied"),
    recordUnmatchedProviderEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function didit(overrides: Partial<DiditClient> = {}): DiditClient {
  return {
    createSession: vi.fn().mockResolvedValue({
      sessionId,
      verificationUrl: `https://verify.didit.me/${sessionId}`,
      status: "Not Started",
      workflowId,
      vendorData: accountId,
    }),
    getDecision: vi.fn().mockResolvedValue({
      sessionId,
      sessionKind: "user",
      workflowId,
      vendorData: accountId,
      status: "Approved",
      idVerifications: [
        { status: "Approved", dateOfBirth: "1990-04-15", warnings: [] },
      ],
      livenessChecks: [{ status: "Approved", warnings: [] }],
      faceMatches: [{ status: "Approved", warnings: [] }],
      amlScreenings: [{ status: "Approved", totalHits: 0, warnings: [] }],
    }),
    ...overrides,
  };
}

describe("KYC application services", () => {
  it("reserves and persists a provider session before returning its redirect", async () => {
    const storage = repository();
    const provider = didit();
    const service = new StartKycSessionService(
      storage,
      provider,
      { workflowId, callbackUrl: "https://app.vistablox.eu/kyc/complete" },
      () => now,
    );

    const result = await service.execute({
      accountId,
      traceId: "req_01",
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "HR",
      language: "en",
    });

    expect(result.data.verification_session_id).toBe(sessionId);
    expect(storage.reserveSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "HR",
      }),
    );
    expect(provider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, workflowId, language: "en" }),
    );
    expect(storage.completeSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, diditReference: sessionId }),
    );
  });

  it("fetches the authoritative decision and applies the local policy", async () => {
    const storage = repository();
    const provider = didit();
    const service = new ProcessDiditWebhookService(storage, provider, {
      workflowId,
      applicationId,
      environment: "sandbox",
    });

    const result = await service.execute(webhookInput());

    expect(result).toEqual({ received: true });
    expect(provider.getDecision).toHaveBeenCalledWith(sessionId);
    expect(storage.applyProviderOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "didit:webhook:c66c07b5-f3bc-40e4-9ec5-c1036f614bf9",
        diditReference: sessionId,
        providerStatus: "Approved",
        outcome: expect.objectContaining({
          eligibilityState: "eligible",
          reasonCode: "KYC_BASELINE_APPROVED",
        }),
      }),
    );
  });

  it("short-circuits replayed events before calling Didit", async () => {
    const storage = repository({ hasProcessedProviderEvent: vi.fn().mockResolvedValue(true) });
    const provider = didit();
    const result = await new ProcessDiditWebhookService(storage, provider, {
      workflowId,
      applicationId,
      environment: "sandbox",
    }).execute(webhookInput());

    expect(result).toEqual({ received: true, duplicate: true });
    expect(provider.getDecision).not.toHaveBeenCalled();
    expect(storage.applyProviderOutcome).not.toHaveBeenCalled();
  });

  it("records but does not apply a mismatched provider correlation", async () => {
    const storage = repository();
    const provider = didit();
    const result = await new ProcessDiditWebhookService(storage, provider, {
      workflowId,
      applicationId,
      environment: "sandbox",
    }).execute({ ...webhookInput(), vendorData: "acct_attacker" });

    expect(result).toEqual({ received: true, ignored: true });
    expect(storage.recordUnmatchedProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "correlation_mismatch" }),
    );
    expect(provider.getDecision).not.toHaveBeenCalled();
    expect(storage.applyProviderOutcome).not.toHaveBeenCalled();
  });
});

function webhookInput() {
  return {
    eventId: "c66c07b5-f3bc-40e4-9ec5-c1036f614bf9",
    webhookType: "status.updated",
    applicationId,
    environment: "sandbox",
    sessionId,
    sessionKind: "user",
    workflowId,
    vendorData: accountId,
    status: "Approved",
    createdAt: Math.floor(now.getTime() / 1_000),
    traceId: "req_01",
  };
}

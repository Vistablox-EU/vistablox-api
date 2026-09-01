import { describe, expect, it, vi } from "vitest";

import type { DiditClient } from "../src/modules/identity/application/didit-client.js";
import {
  GetKycStatusService,
  ProcessDiditWebhookService,
  StartProofOfAddressSessionService,
  StartKycSessionService,
} from "../src/modules/identity/application/kyc.service.js";
import type { KycRepository } from "../src/modules/identity/repository/kyc.repository.js";

const accountId = "acct_01";
const sessionId = "c2237bc6-a76c-4933-b329-6c81843b45c7";
const workflowId = "269214fe-77f7-4b1a-a028-b70e861d73c1";
const proofOfAddressWorkflowId = "bb17fe44-5b38-48f3-acb7-39dbc38c9317";
const proofOfAddressSessionId = "2ecf635b-b3df-43ed-9148-d64e8d6f5bd2";
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
      proofOfAddressDiditReference: null,
      proofOfAddressProviderStatus: null,
      proofOfAddressProviderUpdatedAt: null,
      proofOfAddressStatus: "not_started",
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "HR",
      proofOfAddressCurrentUntil: null,
      lastVerifiedAt: null,
      renewalDueAt: null,
    }),
    findByProofOfAddressDiditReference: vi.fn().mockResolvedValue(null),
    hasProcessedProviderEvent: vi.fn().mockResolvedValue(false),
    reserveSessionStart: vi.fn().mockResolvedValue(true),
    completeSessionStart: vi.fn().mockResolvedValue(true),
    failSessionStart: vi.fn().mockResolvedValue(undefined),
    reserveProofOfAddressSessionStart: vi.fn().mockResolvedValue(true),
    completeProofOfAddressSessionStart: vi.fn().mockResolvedValue(true),
    failProofOfAddressSessionStart: vi.fn().mockResolvedValue(undefined),
    applyProviderOutcome: vi.fn().mockResolvedValue("applied"),
    applyProofOfAddressOutcome: vi.fn().mockResolvedValue("applied"),
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
      proofOfAddressVerifications: [],
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

  it("creates an owner proof-of-address session only after local reservation", async () => {
    const storage = repository();
    const provider = didit({
      createSession: vi.fn().mockResolvedValue({
        sessionId: proofOfAddressSessionId,
        verificationUrl: `https://verify.didit.me/${proofOfAddressSessionId}`,
        status: "Not Started",
        workflowId: proofOfAddressWorkflowId,
        vendorData: accountId,
      }),
    });
    const result = await new StartProofOfAddressSessionService(
      storage,
      provider,
      {
        workflowId: proofOfAddressWorkflowId,
        callbackUrl: "https://app.vistablox.eu/kyc/complete",
      },
      () => now,
    ).execute({ accountId, traceId: "req_01", language: "de" });

    expect(result.data).toMatchObject({
      verification_session_id: proofOfAddressSessionId,
      proof_of_address_status: "in_progress",
    });
    expect(storage.reserveProofOfAddressSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ accountId }),
    );
    expect(provider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: proofOfAddressWorkflowId,
        purpose: "owner_proof_of_address",
        language: "de",
      }),
    );
    expect(storage.completeProofOfAddressSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ diditReference: proofOfAddressSessionId }),
    );
  });

  it("exposes elapsed proof-of-address evidence as expired", async () => {
    const storage = repository({
      getForAccount: vi.fn().mockResolvedValue({
        accountId,
        diditReference: sessionId,
        eligibilityState: "eligible",
        operationalSubstatus: "kyc_verified",
        proofOfAddressDiditReference: proofOfAddressSessionId,
        proofOfAddressProviderStatus: "Approved",
        proofOfAddressProviderUpdatedAt: now,
        proofOfAddressStatus: "current",
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "HR",
        proofOfAddressCurrentUntil: new Date("2026-09-01T11:59:59.000Z"),
        lastVerifiedAt: now,
        renewalDueAt: new Date("2028-09-01T12:00:00.000Z"),
      }),
    });

    expect(
      await new GetKycStatusService(storage, () => now).execute(accountId),
    ).toMatchObject({
      data: { eligibility_state: "eligible", proof_of_address_status: "expired" },
    });
  });

  it("routes an address-workflow webhook through the POA policy", async () => {
    const proofOfAddressRecord = {
      accountId,
      diditReference: sessionId,
      eligibilityState: "eligible" as const,
      operationalSubstatus: "kyc_verified_owner_poa_missing" as const,
      proofOfAddressDiditReference: proofOfAddressSessionId,
      proofOfAddressProviderStatus: "Not Started" as const,
      proofOfAddressProviderUpdatedAt: now,
      proofOfAddressStatus: "in_progress" as const,
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "HR",
      proofOfAddressCurrentUntil: null,
      lastVerifiedAt: now,
      renewalDueAt: new Date("2028-09-01T12:00:00.000Z"),
    };
    const storage = repository({
      findByProofOfAddressDiditReference: vi
        .fn()
        .mockResolvedValue(proofOfAddressRecord),
    });
    const provider = didit({
      getDecision: vi.fn().mockResolvedValue({
        sessionId: proofOfAddressSessionId,
        sessionKind: "user",
        workflowId: proofOfAddressWorkflowId,
        vendorData: accountId,
        status: "Approved",
        idVerifications: [],
        livenessChecks: [],
        faceMatches: [],
        amlScreenings: [],
        proofOfAddressVerifications: [
          {
            status: "Approved",
            issueDate: "2026-06-15",
            countryCode: "DEU",
            warnings: [],
          },
        ],
      }),
    });
    const result = await new ProcessDiditWebhookService(storage, provider, {
      workflowId,
      proofOfAddressWorkflowId,
      applicationId,
      environment: "sandbox",
    }).execute({
      ...webhookInput(),
      sessionId: proofOfAddressSessionId,
      workflowId: proofOfAddressWorkflowId,
    });

    expect(result).toEqual({ received: true });
    expect(storage.findByDiditReference).not.toHaveBeenCalled();
    expect(storage.applyProofOfAddressOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        diditReference: proofOfAddressSessionId,
        outcome: {
          status: "current",
          reasonCode: "OWNER_PROOF_OF_ADDRESS_APPROVED",
          currentUntil: new Date("2026-09-15T00:00:00.000Z"),
        },
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

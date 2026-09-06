import { describe, expect, it, vi } from "vitest";

import type { DiditClient } from "../src/modules/identity/application/didit-client.js";
import {
  GetKycAccountForOperationsService,
  GetKycStatusService,
  ProcessDiditWebhookService,
  ReceiveDiditWebhookService,
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
    enqueueDiditWebhookProcessing: vi.fn().mockResolvedValue(undefined),
    reserveSessionStart: vi.fn().mockResolvedValue(true),
    completeSessionStart: vi.fn().mockResolvedValue(true),
    failSessionStart: vi.fn().mockResolvedValue(undefined),
    reserveProofOfAddressSessionStart: vi.fn().mockResolvedValue(true),
    completeProofOfAddressSessionStart: vi.fn().mockResolvedValue(true),
    failProofOfAddressSessionStart: vi.fn().mockResolvedValue(undefined),
    applyProviderOutcome: vi.fn().mockResolvedValue("applied"),
    applyProofOfAddressOutcome: vi.fn().mockResolvedValue("applied"),
    recordUnmatchedProviderEvent: vi.fn().mockResolvedValue(undefined),
    getRenewalReminderLeadDays: vi.fn().mockResolvedValue(30),
    listEligibleAccountsForRenewalTimer: vi.fn().mockResolvedValue([]),
    transitionToRequiresRenewal: vi.fn().mockResolvedValue(false),
    listStuckSessionCreationsForTimer: vi.fn().mockResolvedValue([]),
    listStuckOpenSessionsForTimer: vi.fn().mockResolvedValue([]),
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
      verifiedDisplayProfile: null,
    }),
    ...overrides,
  };
}

describe("KYC application services", () => {
  it("reserves and persists a provider session before returning its redirect", async () => {
    const storage = repository();
    const provider = didit();
    const invalidateDisplayProfile = vi.fn().mockResolvedValue(undefined);
    const service = new StartKycSessionService(
      storage,
      provider,
      { workflowId, callbackUrl: "https://app.vistablox.eu/kyc/complete" },
      () => now,
      invalidateDisplayProfile,
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
    expect(invalidateDisplayProfile).toHaveBeenCalledWith(accountId);
  });

  it("fails the session start rather than leaving an orphaned session stuck unretryable, when persisting completion fails", async () => {
    const storage = repository({ completeSessionStart: vi.fn().mockResolvedValue(false) });
    const provider = didit();
    const service = new StartKycSessionService(
      storage,
      provider,
      { workflowId, callbackUrl: "https://app.vistablox.eu/kyc/complete" },
      () => now,
    );

    await expect(
      service.execute({
        accountId,
        traceId: "req_01",
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "HR",
      }),
    ).rejects.toMatchObject({ code: "identity.kyc_session_persistence_failed" });

    expect(storage.failSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ accountId }),
    );
  });

  it("durably enqueues webhook processing and acknowledges immediately, without touching the provider or applying policy", async () => {
    const enqueueDiditWebhookProcessing = vi.fn().mockResolvedValue(undefined);
    const storage = repository({ enqueueDiditWebhookProcessing });
    const service = new ReceiveDiditWebhookService(storage);

    const result = await service.execute(webhookInput());

    expect(result).toEqual({ received: true });
    expect(enqueueDiditWebhookProcessing).toHaveBeenCalledWith(webhookInput());
    expect(storage.hasProcessedProviderEvent).not.toHaveBeenCalled();
  });

  it("fetches the authoritative decision and applies the local policy", async () => {
    const storage = repository();
    const provider = didit();
    const invalidateDisplayProfile = vi.fn().mockResolvedValue(undefined);
    const service = new ProcessDiditWebhookService(
      storage,
      provider,
      { workflowId, applicationId, environment: "sandbox" },
      invalidateDisplayProfile,
    );

    const result = await service.execute(webhookInput());

    expect(result).toEqual({ received: true });
    expect(provider.getDecision).toHaveBeenCalledWith(sessionId);
    expect(invalidateDisplayProfile).toHaveBeenCalledWith(accountId);
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
      await new GetKycStatusService(storage, didit(), () => now).execute(accountId),
    ).toMatchObject({
      data: { eligibility_state: "eligible", proof_of_address_status: "expired" },
    });
  });

  it("reports no active session for an account that never started KYC", async () => {
    const storage = repository();
    const provider = didit();

    const result = await new GetKycStatusService(storage, provider, () => now).execute(
      accountId,
    );

    expect(provider.getDecision).not.toHaveBeenCalled();
    expect(result).toMatchObject({ data: { active_session: null } });
  });

  it("reports no active session once KYC has already reached a terminal outcome", async () => {
    const storage = repository({
      getForAccount: vi.fn().mockResolvedValue({
        accountId,
        diditReference: sessionId,
        eligibilityState: "eligible",
        operationalSubstatus: "kyc_verified",
        proofOfAddressDiditReference: null,
        proofOfAddressProviderStatus: null,
        proofOfAddressProviderUpdatedAt: null,
        proofOfAddressStatus: "not_started",
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "HR",
        proofOfAddressCurrentUntil: null,
        lastVerifiedAt: now,
        renewalDueAt: new Date("2028-09-01T12:00:00.000Z"),
      }),
    });
    const provider = didit();

    const result = await new GetKycStatusService(storage, provider, () => now).execute(
      accountId,
    );

    expect(provider.getDecision).not.toHaveBeenCalled();
    expect(result).toMatchObject({ data: { active_session: null } });
  });

  it("exposes a freshly fetched resume URL for an account with a session still open", async () => {
    const storage = repository({
      getForAccount: vi.fn().mockResolvedValue({
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
    });
    const provider = didit({
      getDecision: vi.fn().mockResolvedValue({
        sessionId,
        sessionKind: "user",
        workflowId,
        vendorData: accountId,
        status: "In Progress",
        verificationUrl: `https://verify.didit.me/session/${sessionId}`,
        expiresAt: new Date("2026-09-01T13:00:00.000Z"),
        idVerifications: [],
        livenessChecks: [],
        faceMatches: [],
        amlScreenings: [],
        proofOfAddressVerifications: [],
        verifiedDisplayProfile: null,
      }),
    });

    const result = await new GetKycStatusService(storage, provider, () => now).execute(
      accountId,
    );

    expect(provider.getDecision).toHaveBeenCalledWith(sessionId);
    expect(result).toMatchObject({
      data: {
        active_session: {
          verification_session_id: sessionId,
          verification_url: `https://verify.didit.me/session/${sessionId}`,
          expires_at: "2026-09-01T13:00:00.000Z",
        },
      },
    });
  });

  it("omits the active session when Didit reports the session already reached a terminal status", async () => {
    const storage = repository({
      getForAccount: vi.fn().mockResolvedValue({
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
    });
    const provider = didit({
      getDecision: vi.fn().mockResolvedValue({
        sessionId,
        sessionKind: "user",
        workflowId,
        vendorData: accountId,
        status: "Abandoned",
        verificationUrl: `https://verify.didit.me/session/${sessionId}`,
        expiresAt: null,
        idVerifications: [],
        livenessChecks: [],
        faceMatches: [],
        amlScreenings: [],
        proofOfAddressVerifications: [],
        verifiedDisplayProfile: null,
      }),
    });

    const result = await new GetKycStatusService(storage, provider, () => now).execute(
      accountId,
    );

    expect(result).toMatchObject({ data: { active_session: null } });
  });

  it("degrades to no active session, rather than failing, when Didit is unreachable", async () => {
    const storage = repository({
      getForAccount: vi.fn().mockResolvedValue({
        accountId,
        diditReference: sessionId,
        eligibilityState: "not_started",
        operationalSubstatus: "kyc_pending",
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
    });
    const provider = didit({
      getDecision: vi.fn().mockRejectedValue(new Error("Didit request failed with HTTP 503")),
    });

    const result = await new GetKycStatusService(storage, provider, () => now).execute(
      accountId,
    );

    expect(result).toMatchObject({ data: { active_session: null } });
  });

  it("returns the full operational record to an authorized reviewer, including fields the customer view omits", async () => {
    const storage = repository({
      getForAccount: vi.fn().mockResolvedValue({
        accountId,
        diditReference: sessionId,
        eligibilityState: "pending_manual_review",
        operationalSubstatus: "kyc_manual_review",
        proofOfAddressDiditReference: proofOfAddressSessionId,
        proofOfAddressProviderStatus: "In Review",
        proofOfAddressProviderUpdatedAt: now,
        proofOfAddressStatus: "pending_manual_review",
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "HR",
        proofOfAddressCurrentUntil: null,
        lastVerifiedAt: null,
        renewalDueAt: null,
      }),
    });

    const result = await new GetKycAccountForOperationsService(storage, () => now).execute(
      accountId,
    );

    expect(storage.getForAccount).toHaveBeenCalledWith(accountId);
    expect(result).toEqual({
      data: {
        account_id: accountId,
        eligibility_state: "pending_manual_review",
        operational_substatus: "kyc_manual_review",
        didit_reference: sessionId,
        residence_country_code: "DE",
        tax_residence_country_code: "HR",
        proof_of_address_status: "pending_manual_review",
        proof_of_address_didit_reference: proofOfAddressSessionId,
        proof_of_address_provider_status: "In Review",
        proof_of_address_provider_updated_at: now.toISOString(),
        proof_of_address_current_until: null,
        last_verified_at: null,
        renewal_due_at: null,
      },
    });
  });

  it("resolves an elapsed proof-of-address the same way the customer-facing view does", async () => {
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

    const result = await new GetKycAccountForOperationsService(storage, () => now).execute(
      accountId,
    );

    expect(result.data.proof_of_address_status).toBe("expired");
  });

  it("reports 404 rather than a misleading default when no KYC record exists for the account", async () => {
    const storage = repository({ getForAccount: vi.fn().mockResolvedValue(null) });

    await expect(
      new GetKycAccountForOperationsService(storage, () => now).execute("acct_unknown"),
    ).rejects.toMatchObject({
      code: "identity.kyc_account_not_found",
      status: 404,
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
        verifiedDisplayProfile: null,
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

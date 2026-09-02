import { describe, expect, it, vi } from "vitest";

import type { DiditClient } from "../src/modules/identity/application/didit-client.js";
import {
  ExpireStuckSessionCreationsService,
  ReconcileStuckOpenSessionsService,
} from "../src/modules/identity/application/kyc-stuck-session.service.js";
import type { KycRepository } from "../src/modules/identity/repository/kyc.repository.js";

const accountId = "acct_01";
const diditReference = "c2237bc6-a76c-4933-b329-6c81843b45c7";

function repository(overrides: Partial<KycRepository> = {}): KycRepository {
  return {
    getForAccount: vi.fn(),
    findByDiditReference: vi.fn(),
    findByProofOfAddressDiditReference: vi.fn(),
    hasProcessedProviderEvent: vi.fn(),
    enqueueDiditWebhookProcessing: vi.fn(),
    reserveSessionStart: vi.fn(),
    completeSessionStart: vi.fn(),
    failSessionStart: vi.fn(),
    reserveProofOfAddressSessionStart: vi.fn(),
    completeProofOfAddressSessionStart: vi.fn(),
    failProofOfAddressSessionStart: vi.fn(),
    applyProviderOutcome: vi.fn().mockResolvedValue("applied"),
    applyProofOfAddressOutcome: vi.fn().mockResolvedValue("applied"),
    recordUnmatchedProviderEvent: vi.fn(),
    getRenewalReminderLeadDays: vi.fn(),
    listEligibleAccountsForRenewalTimer: vi.fn(),
    transitionToRequiresRenewal: vi.fn(),
    listStuckSessionCreationsForTimer: vi.fn().mockResolvedValue([]),
    listStuckOpenSessionsForTimer: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function didit(overrides: Partial<DiditClient> = {}): DiditClient {
  return {
    createSession: vi.fn(),
    getDecision: vi.fn().mockResolvedValue({
      sessionId: diditReference,
      sessionKind: "user",
      workflowId: "workflow_01",
      vendorData: accountId,
      status: "Not Started",
      idVerifications: [],
      livenessChecks: [],
      faceMatches: [],
      amlScreenings: [],
      proofOfAddressVerifications: [],
      verifiedDisplayProfile: null,
    }),
    ...overrides,
  };
}

describe("ExpireStuckSessionCreationsService", () => {
  it("fails a baseline session creation stuck past the timeout", async () => {
    const failSessionStart = vi.fn().mockResolvedValue(undefined);
    const service = new ExpireStuckSessionCreationsService(
      repository({
        listStuckSessionCreationsForTimer: vi.fn().mockResolvedValue([
          {
            accountId,
            kind: "baseline" as const,
            sessionStartId: "kyc_start_01",
            updatedAt: new Date("2026-09-02T12:00:00.000Z"),
          },
        ]),
        failSessionStart,
      }),
      () => new Date("2026-09-02T12:15:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(failSessionStart).toHaveBeenCalledWith({
      accountId,
      sessionStartId: "kyc_start_01",
      traceId: "req_trace_01",
      failedAt: new Date("2026-09-02T12:15:00.000Z"),
    });
    expect(summary).toEqual({ checked: 1, acted: 1 });
  });

  it("fails a proof-of-address session creation via the proof-of-address method", async () => {
    const failProofOfAddressSessionStart = vi.fn().mockResolvedValue(undefined);
    const failSessionStart = vi.fn();
    const service = new ExpireStuckSessionCreationsService(
      repository({
        listStuckSessionCreationsForTimer: vi.fn().mockResolvedValue([
          {
            accountId,
            kind: "proof_of_address" as const,
            sessionStartId: "poa_start_01",
            updatedAt: new Date("2026-09-02T12:00:00.000Z"),
          },
        ]),
        failProofOfAddressSessionStart,
        failSessionStart,
      }),
      () => new Date("2026-09-02T12:15:00.000Z"),
    );

    await service.execute("req_trace_01");

    expect(failProofOfAddressSessionStart).toHaveBeenCalledWith({
      accountId,
      sessionStartId: "poa_start_01",
      traceId: "req_trace_01",
      failedAt: new Date("2026-09-02T12:15:00.000Z"),
    });
    expect(failSessionStart).not.toHaveBeenCalled();
  });

  it("does not act on a session creation that has not yet reached the timeout", async () => {
    const failSessionStart = vi.fn();
    const service = new ExpireStuckSessionCreationsService(
      repository({
        listStuckSessionCreationsForTimer: vi.fn().mockResolvedValue([
          {
            accountId,
            kind: "baseline" as const,
            sessionStartId: "kyc_start_01",
            updatedAt: new Date("2026-09-02T12:00:00.000Z"),
          },
        ]),
        failSessionStart,
      }),
      () => new Date("2026-09-02T12:05:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(failSessionStart).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });
});

describe("ReconcileStuckOpenSessionsService", () => {
  it("does not poll Didit for a session that has not yet reached the reconciliation threshold", async () => {
    const provider = didit();
    const service = new ReconcileStuckOpenSessionsService(
      repository({
        listStuckOpenSessionsForTimer: vi.fn().mockResolvedValue([
          {
            accountId,
            kind: "baseline" as const,
            diditReference,
            residenceCountryCode: "DE",
            taxResidenceCountryCode: "HR",
            everRequiredManualReview: false,
            updatedAt: new Date("2026-09-02T12:00:00.000Z"),
          },
        ]),
      }),
      provider,
      () => new Date("2026-09-02T12:30:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(provider.getDecision).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  it("polls Didit past the threshold but does not act while the session is still genuinely pending", async () => {
    const applyProviderOutcome = vi.fn();
    const provider = didit({
      getDecision: vi.fn().mockResolvedValue({
        sessionId: diditReference,
        sessionKind: "user",
        workflowId: "workflow_01",
        vendorData: accountId,
        status: "In Progress",
        idVerifications: [],
        livenessChecks: [],
        faceMatches: [],
        amlScreenings: [],
        proofOfAddressVerifications: [],
        verifiedDisplayProfile: null,
      }),
    });
    const service = new ReconcileStuckOpenSessionsService(
      repository({
        listStuckOpenSessionsForTimer: vi.fn().mockResolvedValue([
          {
            accountId,
            kind: "baseline" as const,
            diditReference,
            residenceCountryCode: "DE",
            taxResidenceCountryCode: "HR",
            everRequiredManualReview: false,
            updatedAt: new Date("2026-09-02T12:00:00.000Z"),
          },
        ]),
        applyProviderOutcome,
      }),
      provider,
      () => new Date("2026-09-02T13:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(provider.getDecision).toHaveBeenCalledWith(diditReference);
    expect(applyProviderOutcome).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  it("applies a baseline session's decision once Didit reports it is no longer pending", async () => {
    const applyProviderOutcome = vi.fn().mockResolvedValue("applied");
    const provider = didit({
      getDecision: vi.fn().mockResolvedValue({
        sessionId: diditReference,
        sessionKind: "user",
        workflowId: "workflow_01",
        vendorData: accountId,
        status: "Expired",
        idVerifications: [],
        livenessChecks: [],
        faceMatches: [],
        amlScreenings: [],
        proofOfAddressVerifications: [],
        verifiedDisplayProfile: null,
      }),
    });
    const now = new Date("2026-09-02T13:00:00.000Z");
    const service = new ReconcileStuckOpenSessionsService(
      repository({
        listStuckOpenSessionsForTimer: vi.fn().mockResolvedValue([
          {
            accountId,
            kind: "baseline" as const,
            diditReference,
            residenceCountryCode: "DE",
            taxResidenceCountryCode: "HR",
            everRequiredManualReview: false,
            updatedAt: new Date("2026-09-02T12:00:00.000Z"),
          },
        ]),
        applyProviderOutcome,
      }),
      provider,
      () => now,
    );

    const summary = await service.execute("req_trace_01");

    expect(applyProviderOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        diditReference,
        providerStatus: "Expired",
        webhookType: "reconciliation_poll",
        traceId: "req_trace_01",
        providerUpdatedAt: now,
        outcome: expect.objectContaining({
          eligibilityState: "not_started",
          operationalSubstatus: "kyc_restart_required",
          reasonCode: "KYC_SESSION_EXPIRED",
        }),
      }),
    );
    expect(summary).toEqual({ checked: 1, acted: 1 });
  });

  it("applies a proof-of-address session's decision via the proof-of-address outcome path", async () => {
    const applyProofOfAddressOutcome = vi.fn().mockResolvedValue("applied");
    const applyProviderOutcome = vi.fn();
    const provider = didit({
      getDecision: vi.fn().mockResolvedValue({
        sessionId: diditReference,
        sessionKind: "user",
        workflowId: "workflow_01",
        vendorData: accountId,
        status: "Abandoned",
        idVerifications: [],
        livenessChecks: [],
        faceMatches: [],
        amlScreenings: [],
        proofOfAddressVerifications: [],
        verifiedDisplayProfile: null,
      }),
    });
    const service = new ReconcileStuckOpenSessionsService(
      repository({
        listStuckOpenSessionsForTimer: vi.fn().mockResolvedValue([
          {
            accountId,
            kind: "proof_of_address" as const,
            diditReference,
            residenceCountryCode: "DE",
            taxResidenceCountryCode: null,
            everRequiredManualReview: false,
            updatedAt: new Date("2026-09-02T12:00:00.000Z"),
          },
        ]),
        applyProofOfAddressOutcome,
        applyProviderOutcome,
      }),
      provider,
      () => new Date("2026-09-02T13:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(applyProofOfAddressOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        diditReference,
        providerStatus: "Abandoned",
        webhookType: "reconciliation_poll",
        outcome: expect.objectContaining({ status: "restart_required" }),
      }),
    );
    expect(applyProviderOutcome).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 1 });
  });
});

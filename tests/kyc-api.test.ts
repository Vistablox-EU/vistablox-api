import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { DiditClient } from "../src/modules/identity/application/didit-client.js";
import {
  GetKycAccountForOperationsService,
  GetKycStatusService,
  ReceiveDiditWebhookService,
  StartKycSessionService,
} from "../src/modules/identity/application/kyc.service.js";
import { DiditWebhookVerifier } from "../src/modules/identity/infrastructure/didit-webhook-verifier.js";
import type { KycRepository } from "../src/modules/identity/repository/kyc.repository.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import type { OriginationRepository } from "../src/modules/origination/repository/origination.repository.js";

const workflowId = "269214fe-77f7-4b1a-a028-b70e861d73c1";
const callbackUrl = "https://app.vistablox.io/kyc/complete";

function fakeKycRepository(overrides: Partial<KycRepository> = {}): KycRepository {
  return {
    getForAccount: vi.fn().mockResolvedValue(null),
    findByDiditReference: vi.fn().mockResolvedValue(null),
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

function fakeDiditClient(overrides: Partial<DiditClient> = {}): DiditClient {
  return {
    createSession: vi.fn(),
    getDecision: vi.fn(),
    ...overrides,
  };
}

// origination routes are mounted unconditionally, so createApp requires a
// full OriginationRepository even though this file never exercises them.
function fakeOriginationRepository(): OriginationRepository {
  return {
    getIntakePrerequisites: vi.fn(),
    createDraftIntake: vi.fn(),
    listOwnedCases: vi.fn().mockResolvedValue([]),
    getOwnedCase: vi.fn().mockResolvedValue(null),
    submitInitialCase: vi.fn(),
    listCasesForOperations: vi.fn().mockResolvedValue([]),
    getCaseForOperations: vi.fn().mockResolvedValue(null),
    getApplicantResponseWindowBusinessDays: vi.fn().mockResolvedValue(10),
    getInformationRequestReminderBusinessDays: vi.fn().mockResolvedValue([3, 7]),
    publishInformationRequest: vi.fn(),
    getOwnedInformationRequest: vi.fn().mockResolvedValue(null),
    listOwnedInformationRequests: vi.fn().mockResolvedValue(null),
    resubmitAfterInformationRequest: vi.fn(),
    recordFounderDecision: vi.fn(),
    listPublishedInformationRequestsForTimers: vi.fn().mockResolvedValue([]),
    expireInformationRequest: vi.fn().mockResolvedValue(false),
    closeCase: vi.fn(),
    listCaseMessages: vi.fn().mockResolvedValue([]),
    postCaseMessage: vi.fn(),
    getCasePartnerAssignment: vi.fn().mockResolvedValue(null),
    assignPartnerOrganization: vi.fn().mockResolvedValue(null),
    listCasesForPartner: vi.fn().mockResolvedValue([]),
    getCaseForPartner: vi.fn().mockResolvedValue(null),
    recordLegalStructuring: vi.fn().mockResolvedValue(null),
    recordAppraisal: vi.fn().mockResolvedValue(null),
  };
}

function fakeStaffWebAuthnRepository() {
  return {
    listCredentials: vi.fn().mockResolvedValue([]),
    findCredential: vi.fn().mockResolvedValue(null),
    isSessionVerified: vi.fn().mockResolvedValue(true),
    replaceChallenge: vi.fn(),
    getActiveChallenge: vi.fn().mockResolvedValue(null),
    failChallenge: vi.fn().mockResolvedValue(false),
    completeRegistration: vi.fn().mockResolvedValue(false),
    completeAuthentication: vi.fn().mockResolvedValue(false),
  };
}

function fakeStaffWebAuthnCeremony() {
  return {
    generateRegistrationOptions: vi.fn(),
    verifyRegistration: vi.fn(),
    generateAuthenticationOptions: vi.fn(),
    verifyAuthentication: vi.fn(),
  };
}

function buildApp(options?: {
  noSession?: boolean;
  population?: "customer" | "staff_partner";
  repository?: KycRepository;
  didit?: DiditClient;
}) {
  const sessions: SessionResolver = {
    resolve:
      options?.noSession === true
        ? vi.fn().mockResolvedValue(null)
        : vi.fn().mockResolvedValue({
            betterAuthUserId: "auth_customer",
            providerSessionId: "session_customer",
            population: options?.population ?? "customer",
          }),
  };
  const accounts: AccountRepository = {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({ accountId: "acct_customer", status: "active" }),
    hasActiveStaffRole: vi.fn().mockResolvedValue(false),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(false),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn().mockResolvedValue(null),
  };
  const repository = options?.repository ?? fakeKycRepository();
  const didit = options?.didit ?? fakeDiditClient();

  return {
    app: createApp({
      databaseProbe: { check: vi.fn() },
      offeringRepository: {
        listPublic: vi.fn().mockResolvedValue([]),
        getInvestorDetail: vi.fn().mockResolvedValue(null),
      },
      logger: pino({ level: "silent" }),
      corsOrigins: [],
      protectedApi: {
        accounts,
        sessions,
        originationRepository: fakeOriginationRepository(),
        staffWebAuthnRepository: fakeStaffWebAuthnRepository(),
        staffWebAuthnCeremony: fakeStaffWebAuthnCeremony(),
        kyc: {
          getStatus: new GetKycStatusService(repository, didit),
          startSession: new StartKycSessionService(repository, didit, { workflowId, callbackUrl }),
          startProofOfAddressSession: undefined,
          getAccountForOperations: new GetKycAccountForOperationsService(repository),
          webhookVerifier: new DiditWebhookVerifier("didit-webhook-secret-for-test"),
          receiveWebhook: new ReceiveDiditWebhookService(repository),
        },
      },
    }),
    repository,
    didit,
  };
}

describe("customer KYC API", () => {
  it("requires an authenticated session", async () => {
    const { app } = buildApp({ noSession: true });

    const response = await request(app).get("/v1/kyc");

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("authentication.required");
  });

  it("denies a staff session on the customer surface", async () => {
    const { app } = buildApp({ population: "staff_partner" });

    const response = await request(app).get("/v1/kyc");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
  });

  it("resolves status using the session's own accountId, never anything client-supplied", async () => {
    const { app, repository } = buildApp();

    const response = await request(app).get("/v1/kyc");

    expect(response.status).toBe(200);
    expect(repository.getForAccount).toHaveBeenCalledWith("acct_customer");
  });

  it("starts a session using the session's own accountId, ignoring any account_id in the body", async () => {
    const didit = fakeDiditClient({
      createSession: vi.fn().mockResolvedValue({
        sessionId: "c2237bc6-a76c-4933-b329-6c81843b45c7",
        verificationUrl: "https://verify.didit.me/session/abc",
        status: "Not Started",
        workflowId,
        vendorData: "acct_customer",
      }),
    });
    const { app, repository } = buildApp({ didit });

    const response = await request(app)
      .post("/v1/kyc/sessions")
      .send({
        residence_country_code: "DE",
        tax_residence_country_code: "DE",
        account_id: "acct_someone_else",
      });

    expect(response.status).toBe(201);
    expect(repository.reserveSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_customer" }),
    );
  });

  it("passes a business-rule conflict through unchanged", async () => {
    const { app } = buildApp({
      repository: fakeKycRepository({ reserveSessionStart: vi.fn().mockResolvedValue(false) }),
    });

    const response = await request(app)
      .post("/v1/kyc/sessions")
      .send({ residence_country_code: "DE", tax_residence_country_code: "DE" });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("identity.kyc_session_unavailable");
  });

  it("reports proof-of-address as not configured when this deployment has no workflow for it", async () => {
    const { app } = buildApp();

    const response = await request(app).post("/v1/kyc/proof-of-address/sessions").send({});

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("identity.proof_of_address_not_configured");
  });
});

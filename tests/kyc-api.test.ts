import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { KycServiceGateway } from "../src/modules/identity/application/kyc-service-gateway.js";
import { AppError } from "../src/shared/errors/app-error.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import type { OriginationRepository } from "../src/modules/origination/repository/origination.repository.js";

function fakeKycServiceGateway(overrides: Partial<KycServiceGateway> = {}): KycServiceGateway {
  return {
    getStatus: vi.fn().mockResolvedValue({
      data: {
        eligibility_state: "not_started",
        proof_of_address_status: "not_started",
        proof_of_address_current_until: null,
        last_verified_at: null,
        renewal_due_at: null,
        active_session: null,
      },
    }),
    startSession: vi.fn().mockResolvedValue({
      data: {
        verification_session_id: "269214fe-77f7-4b1a-a028-b70e861d73c1",
        verification_url: "https://verify.didit.me/session/abc",
        eligibility_state: "not_started",
      },
    }),
    startProofOfAddressSession: vi.fn(),
    getAccountForOperations: vi.fn(),
    getDisplayProfile: vi.fn().mockResolvedValue({ data: null }),
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
  kycGateway?: KycServiceGateway;
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
  const kycGateway = options?.kycGateway ?? fakeKycServiceGateway();

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
        kyc: { client: kycGateway },
      },
    }),
    kycGateway,
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
    const { app, kycGateway } = buildApp();

    const response = await request(app).get("/v1/kyc");

    expect(response.status).toBe(200);
    expect(kycGateway.getStatus).toHaveBeenCalledWith("acct_customer");
  });

  it("starts a session using the session's own accountId, ignoring any account_id in the body", async () => {
    const { app, kycGateway } = buildApp();

    const response = await request(app)
      .post("/v1/kyc/sessions")
      .send({
        residence_country_code: "DE",
        tax_residence_country_code: "DE",
        account_id: "acct_someone_else",
      });

    expect(response.status).toBe(201);
    expect(kycGateway.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_customer" }),
    );
  });

  it("passes a gateway-reported business error through unchanged", async () => {
    const { app } = buildApp({
      kycGateway: fakeKycServiceGateway({
        startSession: vi.fn().mockRejectedValue(
          new AppError({
            code: "identity.kyc_session_unavailable",
            title: "Identity verification session unavailable",
            status: 409,
            detail: "This account cannot start another identity verification session right now.",
          }),
        ),
      }),
    });

    const response = await request(app)
      .post("/v1/kyc/sessions")
      .send({ residence_country_code: "DE", tax_residence_country_code: "DE" });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("identity.kyc_session_unavailable");
  });

  it("reports the KYC service being unreachable as a 503, not a raw 500", async () => {
    const { app } = buildApp({
      kycGateway: fakeKycServiceGateway({
        getStatus: vi.fn().mockRejectedValue(
          new AppError({
            code: "identity.kyc_service_unavailable",
            title: "Identity verification unavailable",
            status: 503,
            detail: "The KYC service is temporarily unavailable.",
          }),
        ),
      }),
    });

    const response = await request(app).get("/v1/kyc");

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("identity.kyc_service_unavailable");
  });
});

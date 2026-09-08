import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import type { OriginationRepository } from "../src/modules/origination/repository/origination.repository.js";
import type { PartnerOrganizationRepository } from "../src/modules/origination/repository/partner-organization.repository.js";

function fakeOriginationRepository(
  overrides: Partial<OriginationRepository> = {},
): OriginationRepository {
  return {
    getIntakePrerequisites: vi.fn(),
    createDraftIntake: vi.fn(),
    listOwnedCases: vi.fn().mockResolvedValue([]),
    getOwnedCase: vi.fn().mockResolvedValue(null),
    submitInitialCase: vi.fn(),
    listCasesForOperations: vi.fn().mockResolvedValue([]),
    getCaseForOperations: vi.fn().mockResolvedValue(null),
    getCasePartnerAssignment: vi
      .fn()
      .mockResolvedValue({ stage: "post_ipo_structuring", legalPracticeId: null, appraisalFirmId: null }),
    assignPartnerOrganization: vi.fn().mockResolvedValue({
      caseId: "case_01",
      legalPracticeId: "legal_practice_01",
      appraisalFirmId: null,
    }),
    listCasesForPartner: vi.fn().mockResolvedValue([]),
    getCaseForPartner: vi.fn().mockResolvedValue(null),
    recordLegalStructuring: vi.fn().mockResolvedValue(null),
    recordAppraisal: vi.fn().mockResolvedValue(null),
    getApplicantResponseWindowBusinessDays: vi.fn().mockResolvedValue(10),
    getInformationRequestReminderBusinessDays: vi.fn().mockResolvedValue([3, 7]),
    publishInformationRequest: vi.fn(),
    getOwnedInformationRequest: vi.fn().mockResolvedValue(null),
    listOwnedInformationRequests: vi.fn().mockResolvedValue(null),
    resubmitAfterInformationRequest: vi.fn(),
    recordFounderDecision: vi.fn(),
    closeCase: vi.fn(),
    listCaseMessages: vi.fn().mockResolvedValue([]),
    postCaseMessage: vi.fn(),
    listPublishedInformationRequestsForTimers: vi.fn().mockResolvedValue([]),
    expireInformationRequest: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function fakePartnerOrganizationRepository(): PartnerOrganizationRepository {
  return {
    createLegalPractice: vi.fn(),
    listLegalPractices: vi.fn(),
    getLegalPracticeById: vi
      .fn()
      .mockResolvedValue({ id: "legal_practice_01", name: "Avocats Example", countryCode: "FR", status: "active" }),
    updateLegalPracticeStatus: vi.fn(),
    createAppraisalFirm: vi.fn(),
    listAppraisalFirms: vi.fn(),
    getAppraisalFirmById: vi.fn().mockResolvedValue(null),
    updateAppraisalFirmStatus: vi.fn(),
  };
}

function fakeStaffWebAuthnRepository(verified: boolean) {
  return {
    listCredentials: vi.fn().mockResolvedValue([]),
    findCredential: vi.fn().mockResolvedValue(null),
    isSessionVerified: vi.fn().mockResolvedValue(verified),
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
  population?: "customer" | "staff_partner";
  hasAdminRole?: boolean;
  includePartnerOrganizations?: boolean;
  originationRepository?: OriginationRepository;
}) {
  const sessions: SessionResolver = {
    resolve: vi.fn().mockResolvedValue({
      betterAuthUserId: "auth_founder",
      providerSessionId: "session_founder",
      population: options?.population ?? "staff_partner",
    }),
  };
  const accounts: AccountRepository = {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({ accountId: "acct_founder", status: "active" }),
    hasActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn().mockResolvedValue(null),
  };
  const originationRepository = options?.originationRepository ?? fakeOriginationRepository();

  return {
    app: createApp({
      databaseProbe: { check: vi.fn() },
      offeringRepository: {
        listPublic: vi.fn().mockResolvedValue([]),
        getInvestorDetail: vi.fn().mockResolvedValue(null),
      },
      logger: pino({ level: "silent" }),
      protectedApi: {
        accounts,
        sessions,
        originationRepository,
        staffWebAuthnRepository: fakeStaffWebAuthnRepository(true),
        staffWebAuthnCeremony: fakeStaffWebAuthnCeremony(),
        ...((options?.includePartnerOrganizations ?? true)
          ? { partnerOrganizations: { repository: fakePartnerOrganizationRepository() } }
          : {}),
      },
    }),
    originationRepository,
  };
}

describe("POST /internal/v1/origination-cases/:case_id/partner-assignment", () => {
  it("is not registered at all when partnerOrganizations isn't configured", async () => {
    const { app } = buildApp({ includePartnerOrganizations: false });

    const response = await request(app)
      .post("/internal/v1/origination-cases/case_01/partner-assignment")
      .send({ legal_practice_id: "legal_practice_01" });

    expect(response.status).toBe(404);
  });

  it("denies a customer", async () => {
    const { app } = buildApp({ population: "customer" });

    const response = await request(app)
      .post("/internal/v1/origination-cases/case_01/partner-assignment")
      .send({ legal_practice_id: "legal_practice_01" });

    expect(response.status).toBe(403);
  });

  it("assigns a legal practice to the case", async () => {
    const { app, originationRepository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/origination-cases/case_01/partner-assignment")
      .send({ legal_practice_id: "legal_practice_01" });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      case_id: "case_01",
      legal_practice_id: "legal_practice_01",
      appraisal_firm_id: null,
    });
    expect(originationRepository.assignPartnerOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: "case_01", legalPracticeId: "legal_practice_01" }),
    );
  });

  it("rejects a body with neither id set", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/internal/v1/origination-cases/case_01/partner-assignment")
      .send({});

    expect(response.status).toBe(422);
  });

  it("409s when the case has not reached an eligible stage", async () => {
    const { app } = buildApp({
      originationRepository: fakeOriginationRepository({
        getCasePartnerAssignment: vi
          .fn()
          .mockResolvedValue({ stage: "pre_offering_open", legalPracticeId: null, appraisalFirmId: null }),
      }),
    });

    const response = await request(app)
      .post("/internal/v1/origination-cases/case_01/partner-assignment")
      .send({ legal_practice_id: "legal_practice_01" });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("origination.review_transition_conflict");
  });
});

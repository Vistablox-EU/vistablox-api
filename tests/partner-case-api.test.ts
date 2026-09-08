import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import type { OriginationRepository, PartnerCaseDetail } from "../src/modules/origination/repository/origination.repository.js";

const partnerCase: PartnerCaseDetail = {
  caseId: "case_01",
  stage: "post_ipo_structuring",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  currentRevision: null,
  property: {
    propertyId: "property_01",
    propertyType: "residential",
    countryCode: "FR",
    city: "Paris",
    addressLine: "1 Rue Example",
    landRegistryReference: "REF-01",
    ownerDeclaredValueEur: "500000.00",
    hasExistingEncumbrance: false,
  },
  legalDocumentRefs: [],
  legalStructuringCompletedAt: null,
  appraisalValueOpinionEur: null,
  appraisalDocumentRefs: [],
  appraisalCompletedAt: null,
  postIpoStructuringCompletedAt: null,
};

function fakeOriginationRepository(overrides: Partial<OriginationRepository> = {}): OriginationRepository {
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
      .mockResolvedValue({ stage: "post_ipo_structuring", legalPracticeId: "legal_practice_01", appraisalFirmId: "appraisal_firm_01" }),
    assignPartnerOrganization: vi.fn().mockResolvedValue(null),
    listCasesForPartner: vi.fn().mockResolvedValue([partnerCase]),
    getCaseForPartner: vi.fn().mockResolvedValue(partnerCase),
    recordLegalStructuring: vi.fn().mockResolvedValue({
      ...partnerCase,
      legalDocumentRefs: ["documents/deed.pdf"],
      legalStructuringCompletedAt: new Date("2026-09-08T12:00:00.000Z"),
    }),
    recordAppraisal: vi.fn().mockResolvedValue({
      ...partnerCase,
      appraisalValueOpinionEur: "520000.00",
      appraisalCompletedAt: new Date("2026-09-08T12:00:00.000Z"),
    }),
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
  role?: "legal_partner" | "appraisal_partner" | "admin_operations" | "none";
  organizationId?: string | null;
  mfaVerified?: boolean;
  originationRepository?: OriginationRepository;
}) {
  const role = options?.role ?? "legal_partner";
  const sessions: SessionResolver = {
    resolve: vi.fn().mockResolvedValue({
      betterAuthUserId: "auth_partner",
      providerSessionId: "session_partner",
      population: options?.population ?? "staff_partner",
    }),
  };
  const accounts: AccountRepository = {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({ accountId: "acct_partner", status: "active" }),
    hasActiveStaffRole: vi.fn().mockImplementation((_accountId: string, checkedRole: string) =>
      Promise.resolve(role !== "none" && checkedRole === role),
    ),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(role !== "none"),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn().mockImplementation((_accountId: string, checkedRole: string) =>
      Promise.resolve(checkedRole === role ? (options?.organizationId ?? "legal_practice_01") : null),
    ),
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
        staffWebAuthnRepository: fakeStaffWebAuthnRepository(options?.mfaVerified ?? true),
        staffWebAuthnCeremony: fakeStaffWebAuthnCeremony(),
      },
    }),
    originationRepository,
  };
}

describe("GET /internal/v1/legal-partner/cases", () => {
  it("lists cases assigned to the caller's own legal practice", async () => {
    const { app } = buildApp({ role: "legal_partner", organizationId: "legal_practice_01" });

    const response = await request(app).get("/internal/v1/legal-partner/cases");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({ case_id: "case_01", stage: "post_ipo_structuring" }),
    ]);
  });

  it("denies a customer", async () => {
    const { app } = buildApp({ population: "customer" });

    const response = await request(app).get("/internal/v1/legal-partner/cases");

    expect(response.status).toBe(403);
  });

  it("denies an appraisal partner", async () => {
    const { app } = buildApp({ role: "appraisal_partner" });

    const response = await request(app).get("/internal/v1/legal-partner/cases");

    expect(response.status).toBe(403);
  });

  it("denies an authorized legal partner until WebAuthn is verified for the session", async () => {
    const { app } = buildApp({ mfaVerified: false });

    const response = await request(app).get("/internal/v1/legal-partner/cases");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authentication.staff_mfa_required");
  });
});

describe("GET /internal/v1/legal-partner/cases/:case_id", () => {
  it("opens a case assigned to the caller's own practice", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/internal/v1/legal-partner/cases/case_01");

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ case_id: "case_01", stage: "post_ipo_structuring" });
  });

  it("denies a case assigned to a different legal practice", async () => {
    const { app } = buildApp({
      organizationId: "legal_practice_01",
      originationRepository: fakeOriginationRepository({
        getCasePartnerAssignment: vi
          .fn()
          .mockResolvedValue({ stage: "post_ipo_structuring", legalPracticeId: "legal_practice_02", appraisalFirmId: null }),
      }),
    });

    const response = await request(app).get("/internal/v1/legal-partner/cases/case_01");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
  });

  it("denies a case that has not reached an accessible stage", async () => {
    const { app } = buildApp({
      originationRepository: fakeOriginationRepository({
        getCasePartnerAssignment: vi
          .fn()
          .mockResolvedValue({ stage: "pre_offering_open", legalPracticeId: "legal_practice_01", appraisalFirmId: null }),
      }),
    });

    const response = await request(app).get("/internal/v1/legal-partner/cases/case_01");

    expect(response.status).toBe(403);
  });
});

describe("PATCH /internal/v1/legal-partner/cases/:case_id", () => {
  it("records legal document refs and completion", async () => {
    const { app, originationRepository } = buildApp();

    const response = await request(app)
      .patch("/internal/v1/legal-partner/cases/case_01")
      .send({ legal_document_refs: ["documents/deed.pdf"], mark_completed: true });

    expect(response.status).toBe(200);
    expect(response.body.data.legal_document_refs).toEqual(["documents/deed.pdf"]);
    expect(originationRepository.recordLegalStructuring).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: "case_01", legalDocumentRefs: ["documents/deed.pdf"], markCompleted: true }),
    );
  });

  it("rejects an empty body", async () => {
    const { app } = buildApp();

    const response = await request(app).patch("/internal/v1/legal-partner/cases/case_01").send({});

    expect(response.status).toBe(422);
  });

  it("rejects mark_completed: false rather than silently ignoring it", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .patch("/internal/v1/legal-partner/cases/case_01")
      .send({ mark_completed: false });

    expect(response.status).toBe(422);
  });

  it("409s once the case has already advanced to approved_for_final_offering", async () => {
    const { app } = buildApp({
      originationRepository: fakeOriginationRepository({
        getCasePartnerAssignment: vi
          .fn()
          .mockResolvedValue({ stage: "approved_for_final_offering", legalPracticeId: "legal_practice_01", appraisalFirmId: null }),
      }),
    });

    const response = await request(app)
      .patch("/internal/v1/legal-partner/cases/case_01")
      .send({ mark_completed: true });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("origination.review_transition_conflict");
  });

  it("denies an appraisal partner writing through the legal endpoint", async () => {
    const { app } = buildApp({ role: "appraisal_partner" });

    const response = await request(app)
      .patch("/internal/v1/legal-partner/cases/case_01")
      .send({ mark_completed: true });

    expect(response.status).toBe(403);
  });
});

describe("GET /internal/v1/appraisal-partner/cases", () => {
  it("lists cases assigned to the caller's own appraisal firm", async () => {
    const { app } = buildApp({ role: "appraisal_partner", organizationId: "appraisal_firm_01" });

    const response = await request(app).get("/internal/v1/appraisal-partner/cases");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({ case_id: "case_01", stage: "post_ipo_structuring" }),
    ]);
  });
});

describe("PATCH /internal/v1/appraisal-partner/cases/:case_id", () => {
  it("records the appraisal value opinion and documents", async () => {
    const { app, originationRepository } = buildApp({ role: "appraisal_partner", organizationId: "appraisal_firm_01" });

    const response = await request(app)
      .patch("/internal/v1/appraisal-partner/cases/case_01")
      .send({ appraisal_value_opinion_eur: "520000.00", appraisal_document_refs: ["documents/valuation.pdf"] });

    expect(response.status).toBe(200);
    expect(response.body.data.appraisal_value_opinion_eur).toBe("520000.00");
    expect(originationRepository.recordAppraisal).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: "case_01",
        appraisalValueOpinionEur: "520000.00",
        appraisalDocumentRefs: ["documents/valuation.pdf"],
      }),
    );
  });

  it("rejects a malformed appraisal value", async () => {
    const { app } = buildApp({ role: "appraisal_partner", organizationId: "appraisal_firm_01" });

    const response = await request(app)
      .patch("/internal/v1/appraisal-partner/cases/case_01")
      .send({ appraisal_value_opinion_eur: "not-a-number" });

    expect(response.status).toBe(422);
  });

  it("denies a legal partner writing through the appraisal endpoint", async () => {
    const { app } = buildApp({ role: "legal_partner" });

    const response = await request(app)
      .patch("/internal/v1/appraisal-partner/cases/case_01")
      .send({ mark_completed: true });

    expect(response.status).toBe(403);
  });
});

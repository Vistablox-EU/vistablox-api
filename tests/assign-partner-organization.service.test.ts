import { describe, expect, it, vi } from "vitest";

import { AssignPartnerOrganizationService } from "../src/modules/origination/application/operations-case.service.js";
import { CaseReviewConflictError } from "../src/modules/origination/repository/origination.repository.js";
import type { OriginationRepository } from "../src/modules/origination/repository/origination.repository.js";
import type { PartnerOrganizationRepository } from "../src/modules/origination/repository/partner-organization.repository.js";

const now = new Date("2026-09-08T12:00:00.000Z");

function fakeCases(overrides: Partial<OriginationRepository> = {}): OriginationRepository {
  return {
    getIntakePrerequisites: vi.fn(),
    createDraftIntake: vi.fn(),
    listOwnedCases: vi.fn(),
    getOwnedCase: vi.fn(),
    submitInitialCase: vi.fn(),
    listCasesForOperations: vi.fn(),
    getCaseForOperations: vi.fn(),
    getCasePartnerAssignment: vi
      .fn()
      .mockResolvedValue({ stage: "post_ipo_structuring", legalPracticeId: null, appraisalFirmId: null }),
    assignPartnerOrganization: vi.fn().mockResolvedValue({
      caseId: "case_01",
      legalPracticeId: "legal_practice_01",
      appraisalFirmId: null,
    }),
    listCasesForPartner: vi.fn(),
    getCaseForPartner: vi.fn(),
    recordLegalStructuring: vi.fn(),
    recordAppraisal: vi.fn(),
    getApplicantResponseWindowBusinessDays: vi.fn(),
    getInformationRequestReminderBusinessDays: vi.fn(),
    publishInformationRequest: vi.fn(),
    getOwnedInformationRequest: vi.fn(),
    listOwnedInformationRequests: vi.fn(),
    resubmitAfterInformationRequest: vi.fn(),
    recordFounderDecision: vi.fn(),
    closeCase: vi.fn(),
    listCaseMessages: vi.fn(),
    postCaseMessage: vi.fn(),
    listPublishedInformationRequestsForTimers: vi.fn(),
    expireInformationRequest: vi.fn(),
    ...overrides,
  };
}

function fakePartnerOrganizations(
  overrides: Partial<PartnerOrganizationRepository> = {},
): PartnerOrganizationRepository {
  return {
    createLegalPractice: vi.fn(),
    listLegalPractices: vi.fn(),
    getLegalPracticeById: vi
      .fn()
      .mockResolvedValue({ id: "legal_practice_01", name: "Avocats Example", countryCode: "FR", status: "active" }),
    updateLegalPracticeStatus: vi.fn(),
    createAppraisalFirm: vi.fn(),
    listAppraisalFirms: vi.fn(),
    getAppraisalFirmById: vi
      .fn()
      .mockResolvedValue({ id: "appraisal_firm_01", name: "Example Valuations", countryCode: "DE", status: "active" }),
    updateAppraisalFirmStatus: vi.fn(),
    ...overrides,
  };
}

describe("assign partner organization service", () => {
  it("assigns a legal practice to a post-IPO-structuring case", async () => {
    const cases = fakeCases();
    const partnerOrganizations = fakePartnerOrganizations();
    const service = new AssignPartnerOrganizationService(cases, partnerOrganizations, () => now);

    const result = await service.execute({
      caseId: "case_01",
      actorAccountId: "acct_founder",
      traceId: "trace_1",
      body: { legal_practice_id: "legal_practice_01" },
    });

    expect(partnerOrganizations.getLegalPracticeById).toHaveBeenCalledWith("legal_practice_01");
    expect(cases.assignPartnerOrganization).toHaveBeenCalledWith({
      caseId: "case_01",
      legalPracticeId: "legal_practice_01",
      actorAccountId: "acct_founder",
      traceId: "trace_1",
      assignedAt: now,
    });
    expect(result.data).toEqual({
      case_id: "case_01",
      legal_practice_id: "legal_practice_01",
      appraisal_firm_id: null,
    });
  });

  it("rejects assignment before the case has reached an eligible stage", async () => {
    const cases = fakeCases({
      getCasePartnerAssignment: vi
        .fn()
        .mockResolvedValue({ stage: "pre_offering_open", legalPracticeId: null, appraisalFirmId: null }),
    });
    const service = new AssignPartnerOrganizationService(cases, fakePartnerOrganizations(), () => now);

    await expect(
      service.execute({
        caseId: "case_01",
        actorAccountId: "acct_founder",
        traceId: "trace_2",
        body: { legal_practice_id: "legal_practice_01" },
      }),
    ).rejects.toMatchObject({ status: 409, code: "origination.review_transition_conflict" });
    expect(cases.assignPartnerOrganization).not.toHaveBeenCalled();
  });

  it("allows assignment once the case has reached approved_for_final_offering", async () => {
    const cases = fakeCases({
      getCasePartnerAssignment: vi
        .fn()
        .mockResolvedValue({ stage: "approved_for_final_offering", legalPracticeId: null, appraisalFirmId: null }),
    });
    const service = new AssignPartnerOrganizationService(cases, fakePartnerOrganizations(), () => now);

    const result = await service.execute({
      caseId: "case_01",
      actorAccountId: "acct_founder",
      traceId: "trace_3",
      body: { appraisal_firm_id: "appraisal_firm_01" },
    });

    expect(result.data.case_id).toBe("case_01");
  });

  it("404s when the case does not exist", async () => {
    const cases = fakeCases({ getCasePartnerAssignment: vi.fn().mockResolvedValue(null) });
    const service = new AssignPartnerOrganizationService(cases, fakePartnerOrganizations(), () => now);

    await expect(
      service.execute({
        caseId: "case_missing",
        actorAccountId: "acct_founder",
        traceId: "trace_4",
        body: { legal_practice_id: "legal_practice_01" },
      }),
    ).rejects.toMatchObject({ status: 404, code: "origination.case_not_found" });
  });

  it("404s when the legal practice does not exist", async () => {
    const partnerOrganizations = fakePartnerOrganizations({
      getLegalPracticeById: vi.fn().mockResolvedValue(null),
    });
    const service = new AssignPartnerOrganizationService(fakeCases(), partnerOrganizations, () => now);

    await expect(
      service.execute({
        caseId: "case_01",
        actorAccountId: "acct_founder",
        traceId: "trace_5",
        body: { legal_practice_id: "legal_practice_missing" },
      }),
    ).rejects.toMatchObject({ status: 404, code: "origination.legal_practice_not_found" });
  });

  it("refuses to assign a suspended appraisal firm", async () => {
    const partnerOrganizations = fakePartnerOrganizations({
      getAppraisalFirmById: vi
        .fn()
        .mockResolvedValue({ id: "appraisal_firm_01", name: "Example Valuations", countryCode: "DE", status: "suspended" }),
    });
    const service = new AssignPartnerOrganizationService(fakeCases(), partnerOrganizations, () => now);

    await expect(
      service.execute({
        caseId: "case_01",
        actorAccountId: "acct_founder",
        traceId: "trace_6",
        body: { appraisal_firm_id: "appraisal_firm_01" },
      }),
    ).rejects.toMatchObject({ status: 409, code: "origination.appraisal_firm_not_active" });
    expect(fakeCases().assignPartnerOrganization).not.toHaveBeenCalled();
  });

  it("maps a race-condition CaseReviewConflictError from the repository to the same 409", async () => {
    const cases = fakeCases({
      assignPartnerOrganization: vi
        .fn()
        .mockRejectedValue(new CaseReviewConflictError("pre_offering_open", "assign a legal practice or appraisal firm")),
    });
    const service = new AssignPartnerOrganizationService(cases, fakePartnerOrganizations(), () => now);

    await expect(
      service.execute({
        caseId: "case_01",
        actorAccountId: "acct_founder",
        traceId: "trace_7",
        body: { legal_practice_id: "legal_practice_01" },
      }),
    ).rejects.toMatchObject({ status: 409, code: "origination.review_transition_conflict" });
  });
});

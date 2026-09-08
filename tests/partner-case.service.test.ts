import { describe, expect, it, vi } from "vitest";

import {
  GetCaseForPartnerService,
  ListCasesForPartnerService,
  RecordAppraisalService,
  RecordLegalStructuringService,
} from "../src/modules/origination/application/partner-case.service.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import { CaseReviewConflictError } from "../src/modules/origination/repository/origination.repository.js";
import type { OriginationRepository, PartnerCaseDetail } from "../src/modules/origination/repository/origination.repository.js";

const now = new Date("2026-09-08T12:00:00.000Z");

const baseCase: PartnerCaseDetail = {
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

function fakeAccounts(organizationId: string | null = "legal_practice_01"): AccountRepository {
  return {
    findByBetterAuthUserId: vi.fn(),
    hasActiveStaffRole: vi.fn(),
    hasAnyActiveStaffRole: vi.fn(),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn().mockResolvedValue(organizationId),
  };
}

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
      .mockResolvedValue({ stage: "post_ipo_structuring", legalPracticeId: "legal_practice_01", appraisalFirmId: null }),
    assignPartnerOrganization: vi.fn(),
    listCasesForPartner: vi.fn().mockResolvedValue([baseCase]),
    getCaseForPartner: vi.fn().mockResolvedValue(baseCase),
    recordLegalStructuring: vi.fn().mockResolvedValue({
      ...baseCase,
      legalDocumentRefs: ["documents/deed.pdf"],
      legalStructuringCompletedAt: now,
    }),
    recordAppraisal: vi.fn().mockResolvedValue({
      ...baseCase,
      appraisalValueOpinionEur: "520000.00",
      appraisalCompletedAt: now,
    }),
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

describe("ListCasesForPartnerService", () => {
  it("lists cases for the caller's own resolved organization", async () => {
    const accounts = fakeAccounts("legal_practice_01");
    const cases = fakeCases();
    const service = new ListCasesForPartnerService("legal_partner", accounts, cases);

    const result = await service.execute({ accountId: "acct_partner", query: { limit: 20 } });

    expect(accounts.getActivePartnerOrganizationId).toHaveBeenCalledWith("acct_partner", "legal_partner");
    expect(cases.listCasesForPartner).toHaveBeenCalledWith({
      role: "legal_partner",
      organizationId: "legal_practice_01",
      limit: 21,
    });
    expect(result.data).toEqual([
      expect.objectContaining({ case_id: "case_01", stage: "post_ipo_structuring" }),
    ]);
    expect(result.page.next_cursor).toBeNull();
  });

  it("returns an empty page rather than an error when the account holds no active assignment", async () => {
    const accounts = fakeAccounts(null);
    const cases = fakeCases();
    const service = new ListCasesForPartnerService("appraisal_partner", accounts, cases);

    const result = await service.execute({ accountId: "acct_partner", query: { limit: 20 } });

    expect(result).toEqual({ data: [], page: { next_cursor: null } });
    expect(cases.listCasesForPartner).not.toHaveBeenCalled();
  });

  it("paginates when more rows come back than the page limit", async () => {
    const accounts = fakeAccounts("appraisal_firm_01");
    const cases = fakeCases({
      listCasesForPartner: vi
        .fn()
        .mockResolvedValue([
          baseCase,
          { ...baseCase, caseId: "case_02", createdAt: new Date("2026-09-02T00:00:00.000Z") },
        ]),
    });
    const service = new ListCasesForPartnerService("appraisal_partner", accounts, cases);

    const result = await service.execute({ accountId: "acct_partner", query: { limit: 1 } });

    expect(result.data).toHaveLength(1);
    expect(result.page.next_cursor).not.toBeNull();
  });
});

describe("GetCaseForPartnerService", () => {
  it("returns the partner-scoped case detail", async () => {
    const cases = fakeCases();
    const service = new GetCaseForPartnerService(cases);

    const result = await service.execute("case_01");

    expect(result.data).toMatchObject({ case_id: "case_01", stage: "post_ipo_structuring" });
  });

  it("404s when the case does not exist", async () => {
    const cases = fakeCases({ getCaseForPartner: vi.fn().mockResolvedValue(null) });
    const service = new GetCaseForPartnerService(cases);

    await expect(service.execute("case_missing")).rejects.toMatchObject({
      status: 404,
      code: "origination.case_not_found",
    });
  });
});

describe("RecordLegalStructuringService", () => {
  it("records legal document refs and marks structuring completed", async () => {
    const cases = fakeCases();
    const service = new RecordLegalStructuringService(cases, () => now);

    const result = await service.execute({
      caseId: "case_01",
      actorAccountId: "acct_legal",
      traceId: "trace_1",
      body: { legal_document_refs: ["documents/deed.pdf"], mark_completed: true },
    });

    expect(cases.recordLegalStructuring).toHaveBeenCalledWith({
      caseId: "case_01",
      legalDocumentRefs: ["documents/deed.pdf"],
      markCompleted: true,
      actorAccountId: "acct_legal",
      traceId: "trace_1",
      recordedAt: now,
    });
    expect(result.data.legal_structuring_completed_at).toBe(now.toISOString());
  });

  it("404s when the case does not exist", async () => {
    const cases = fakeCases({ getCasePartnerAssignment: vi.fn().mockResolvedValue(null) });
    const service = new RecordLegalStructuringService(cases, () => now);

    await expect(
      service.execute({
        caseId: "case_missing",
        actorAccountId: "acct_legal",
        traceId: "trace_2",
        body: { mark_completed: true },
      }),
    ).rejects.toMatchObject({ status: 404, code: "origination.case_not_found" });
    expect(cases.recordLegalStructuring).not.toHaveBeenCalled();
  });

  it("409s once the case has already advanced to approved_for_final_offering", async () => {
    const cases = fakeCases({
      getCasePartnerAssignment: vi
        .fn()
        .mockResolvedValue({ stage: "approved_for_final_offering", legalPracticeId: "legal_practice_01", appraisalFirmId: null }),
    });
    const service = new RecordLegalStructuringService(cases, () => now);

    await expect(
      service.execute({
        caseId: "case_01",
        actorAccountId: "acct_legal",
        traceId: "trace_3",
        body: { mark_completed: true },
      }),
    ).rejects.toMatchObject({ status: 409, code: "origination.review_transition_conflict" });
    expect(cases.recordLegalStructuring).not.toHaveBeenCalled();
  });

  it("maps a race-condition CaseReviewConflictError from the repository to the same 409", async () => {
    const cases = fakeCases({
      recordLegalStructuring: vi
        .fn()
        .mockRejectedValue(new CaseReviewConflictError("approved_for_final_offering", "record legal structuring")),
    });
    const service = new RecordLegalStructuringService(cases, () => now);

    await expect(
      service.execute({
        caseId: "case_01",
        actorAccountId: "acct_legal",
        traceId: "trace_4",
        body: { mark_completed: true },
      }),
    ).rejects.toMatchObject({ status: 409, code: "origination.review_transition_conflict" });
  });
});

describe("RecordAppraisalService", () => {
  it("records the appraisal value opinion and documents", async () => {
    const cases = fakeCases();
    const service = new RecordAppraisalService(cases, () => now);

    const result = await service.execute({
      caseId: "case_01",
      actorAccountId: "acct_appraisal",
      traceId: "trace_5",
      body: { appraisal_value_opinion_eur: "520000.00" },
    });

    expect(cases.recordAppraisal).toHaveBeenCalledWith({
      caseId: "case_01",
      appraisalValueOpinionEur: "520000.00",
      actorAccountId: "acct_appraisal",
      traceId: "trace_5",
      recordedAt: now,
    });
    expect(result.data.appraisal_value_opinion_eur).toBe("520000.00");
  });

  it("404s when the case does not exist", async () => {
    const cases = fakeCases({ getCasePartnerAssignment: vi.fn().mockResolvedValue(null) });
    const service = new RecordAppraisalService(cases, () => now);

    await expect(
      service.execute({
        caseId: "case_missing",
        actorAccountId: "acct_appraisal",
        traceId: "trace_6",
        body: { mark_completed: true },
      }),
    ).rejects.toMatchObject({ status: 404, code: "origination.case_not_found" });
  });

  it("409s before the case has reached post_ipo_structuring", async () => {
    const cases = fakeCases({
      getCasePartnerAssignment: vi
        .fn()
        .mockResolvedValue({ stage: "pre_offering_open", legalPracticeId: null, appraisalFirmId: null }),
    });
    const service = new RecordAppraisalService(cases, () => now);

    await expect(
      service.execute({
        caseId: "case_01",
        actorAccountId: "acct_appraisal",
        traceId: "trace_7",
        body: { mark_completed: true },
      }),
    ).rejects.toMatchObject({ status: 409, code: "origination.review_transition_conflict" });
    expect(cases.recordAppraisal).not.toHaveBeenCalled();
  });
});

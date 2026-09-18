import { describe, expect, it, vi } from "vitest";

import { WithdrawInformationRequestService } from "../src/modules/intake/application/operations-case.service.js";
import {
  CaseReviewConflictError,
  type OperationsCaseDetail,
  type IntakeRepository,
} from "../src/modules/intake/repository/intake.repository.js";

const now = new Date("2026-09-08T12:00:00.000Z");

const waitingCaseWithPublishedRequest: OperationsCaseDetail = {
  caseId: "case_01",
  stage: "waiting_on_applicant",
  createdAt: new Date("2026-08-30T10:00:00.000Z"),
  updatedAt: new Date("2026-08-31T09:00:00.000Z"),
  currentRevision: { revisionNumber: 1, submittedAt: new Date("2026-08-31T09:00:00.000Z") },
  property: {
    propertyId: "prop_01",
    propertyType: "residential",
    countryCode: "RS",
    city: "Belgrade",
    addressLine: "Example 1",
    landRegistryReference: "BG-123",
    ownerDeclaredValueEur: "175000.00",
    hasExistingEncumbrance: false,
    residentialSubtype: null,
    livingAreaSqM: null,
    bedrooms: null,
    bathrooms: null,
    floor: null,
    totalFloors: null,
    yearBuilt: null,
    condition: null,
    energyRating: null,
    rooms: [],
  },
  applicantAccountId: "acct_owner",
  legalPracticeId: null,
  appraisalFirmId: null,
  offering: null,
  founderReviewNotes: null,
  reviewedByAccountId: null,
  approvedAt: null,
  rejectedAt: null,
  rejectionReasonCode: null,
  rejectionNotes: null,
  ipoPeriodDays: null,
  ipoEndAt: null,
  ipoValueEur: null,
  submission: {
    revisionId: "rev_01",
    revisionNumber: 1,
    submittedAt: new Date("2026-08-31T09:00:00.000Z"),
    submittedByAccountId: "acct_owner",
    submissionData: { ownership: { applicant_is_owner: true } },
    evidence: [],
  },
  informationRequests: [
    {
      requestId: "rfi_01",
      caseId: "case_01",
      status: "published",
      requestBody: "Please provide a newer registry extract.",
      publishedAt: new Date("2026-08-31T10:00:00.000Z"),
      dueAt: new Date("2026-09-14T10:00:00.000Z"),
      resolvedAt: null,
      resolutionType: null,
      resolvingRevisionId: null,
    },
  ],
};

function fakeCases(overrides: Partial<IntakeRepository> = {}): IntakeRepository {
  return {
    getIntakePrerequisites: vi.fn(),
    createDraftIntake: vi.fn(),
    getMinimumPropertyValueEur: vi.fn(),
    createStaffCase: vi.fn(),
    listOwnedCases: vi.fn(),
    getOwnedCase: vi.fn(),
    submitInitialCase: vi.fn(),
    listCasesForOperations: vi.fn(),
    getCaseForOperations: vi.fn().mockResolvedValue(waitingCaseWithPublishedRequest),
    getCasePartnerAssignment: vi.fn(),
    assignPartnerOrganization: vi.fn(),
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
    withdrawInformationRequest: vi.fn().mockResolvedValue({
      requestId: "rfi_01",
      caseId: "case_01",
      status: "withdrawn",
      resolvedAt: now,
      stage: "submitted",
    }),
    recordFounderDecision: vi.fn(),
    closeCase: vi.fn(),
    reviewEvidence: vi.fn(),
    listCaseMessages: vi.fn(),
    postCaseMessage: vi.fn(),
    listPublishedInformationRequestsForTimers: vi.fn(),
    getPublishedInformationRequestForTimer: vi.fn(),
    expireInformationRequest: vi.fn(),
    transitionToPostIpoStructuring: vi.fn(),
    ...overrides,
  };
}

describe("withdraw information request service", () => {
  it("withdraws a published request on a waiting_on_applicant case", async () => {
    const cases = fakeCases();
    const service = new WithdrawInformationRequestService(cases, () => now);

    const result = await service.execute({
      accountId: "acct_founder",
      caseId: "case_01",
      requestId: "rfi_01",
      traceId: "trace_1",
      body: { founder_review_notes: "Published in error." },
    });

    expect(cases.withdrawInformationRequest).toHaveBeenCalledWith({
      accountId: "acct_founder",
      caseId: "case_01",
      requestId: "rfi_01",
      traceId: "trace_1",
      founderReviewNotes: "Published in error.",
      withdrawnAt: now,
    });
    expect(result.data).toEqual({
      request_id: "rfi_01",
      case_id: "case_01",
      status: "withdrawn",
      resolved_at: now.toISOString(),
      stage: "submitted",
    });
  });

  it("404s when the case does not exist", async () => {
    const cases = fakeCases({ getCaseForOperations: vi.fn().mockResolvedValue(null) });
    const service = new WithdrawInformationRequestService(cases, () => now);

    await expect(
      service.execute({
        accountId: "acct_founder",
        caseId: "case_missing",
        requestId: "rfi_01",
        traceId: "trace_2",
        body: { founder_review_notes: null },
      }),
    ).rejects.toMatchObject({ status: 404, code: "intake.case_not_found" });
    expect(cases.withdrawInformationRequest).not.toHaveBeenCalled();
  });

  it("404s when the request id doesn't belong to the case", async () => {
    const cases = fakeCases();
    const service = new WithdrawInformationRequestService(cases, () => now);

    await expect(
      service.execute({
        accountId: "acct_founder",
        caseId: "case_01",
        requestId: "rfi_missing",
        traceId: "trace_3",
        body: { founder_review_notes: null },
      }),
    ).rejects.toMatchObject({ status: 404, code: "intake.case_not_found" });
    expect(cases.withdrawInformationRequest).not.toHaveBeenCalled();
  });

  it("409s when the case has moved past waiting_on_applicant", async () => {
    const cases = fakeCases({
      getCaseForOperations: vi
        .fn()
        .mockResolvedValue({ ...waitingCaseWithPublishedRequest, stage: "submitted" }),
    });
    const service = new WithdrawInformationRequestService(cases, () => now);

    await expect(
      service.execute({
        accountId: "acct_founder",
        caseId: "case_01",
        requestId: "rfi_01",
        traceId: "trace_4",
        body: { founder_review_notes: null },
      }),
    ).rejects.toMatchObject({ status: 409, code: "intake.review_transition_conflict" });
    expect(cases.withdrawInformationRequest).not.toHaveBeenCalled();
  });

  it("409s when the request is no longer published", async () => {
    const cases = fakeCases({
      getCaseForOperations: vi.fn().mockResolvedValue({
        ...waitingCaseWithPublishedRequest,
        informationRequests: [
          { ...waitingCaseWithPublishedRequest.informationRequests[0], status: "answered" },
        ],
      }),
    });
    const service = new WithdrawInformationRequestService(cases, () => now);

    await expect(
      service.execute({
        accountId: "acct_founder",
        caseId: "case_01",
        requestId: "rfi_01",
        traceId: "trace_5",
        body: { founder_review_notes: null },
      }),
    ).rejects.toMatchObject({ status: 409, code: "intake.review_transition_conflict" });
    expect(cases.withdrawInformationRequest).not.toHaveBeenCalled();
  });

  it("maps a race-condition CaseReviewConflictError from the repository to the same 409", async () => {
    const cases = fakeCases({
      withdrawInformationRequest: vi
        .fn()
        .mockRejectedValue(
          new CaseReviewConflictError("submitted", "withdraw this information request"),
        ),
    });
    const service = new WithdrawInformationRequestService(cases, () => now);

    await expect(
      service.execute({
        accountId: "acct_founder",
        caseId: "case_01",
        requestId: "rfi_01",
        traceId: "trace_6",
        body: { founder_review_notes: null },
      }),
    ).rejects.toMatchObject({ status: 409, code: "intake.review_transition_conflict" });
  });

  it("404s when the repository reports the case vanished", async () => {
    const cases = fakeCases({ withdrawInformationRequest: vi.fn().mockResolvedValue(null) });
    const service = new WithdrawInformationRequestService(cases, () => now);

    await expect(
      service.execute({
        accountId: "acct_founder",
        caseId: "case_01",
        requestId: "rfi_01",
        traceId: "trace_7",
        body: { founder_review_notes: null },
      }),
    ).rejects.toMatchObject({ status: 404, code: "intake.case_not_found" });
  });
});

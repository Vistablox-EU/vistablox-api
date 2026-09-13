import { describe, expect, it, vi } from "vitest";

import { RetryPostIpoStructuringHandoffService } from "../src/modules/origination/application/operations-case.service.js";
import { TransitionCaseToPostIpoStructuringService } from "../src/modules/origination/application/post-ipo-structuring-handoff.service.js";
import { AppError } from "../src/shared/errors/app-error.js";
import type {
  OperationsCaseDetail,
  OriginationRepository,
} from "../src/modules/origination/repository/origination.repository.js";
import type { PostIpoStructuringHandoffRepository } from "../src/modules/origination/repository/post-ipo-structuring-handoff.repository.js";

const now = new Date("2026-09-08T20:00:00.000Z");

const baseCase: OperationsCaseDetail = {
  caseId: "case_01",
  stage: "pre_offering_open",
  createdAt: new Date("2026-08-30T10:00:00.000Z"),
  updatedAt: new Date("2026-08-31T09:00:00.000Z"),
  currentRevision: null,
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
  submission: null,
  informationRequests: [],
};

function fakeRepository(overrides: Partial<OriginationRepository> = {}): OriginationRepository {
  return {
    getIntakePrerequisites: vi.fn(),
    createDraftIntake: vi.fn(),
    getMinimumPropertyValueEur: vi.fn(),
    createStaffCase: vi.fn(),
    listOwnedCases: vi.fn(),
    getOwnedCase: vi.fn(),
    submitInitialCase: vi.fn(),
    listCasesForOperations: vi.fn(),
    getCaseForOperations: vi.fn().mockResolvedValue(baseCase),
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
    recordFounderDecision: vi.fn(),
    closeCase: vi.fn(),
    listCaseMessages: vi.fn(),
    postCaseMessage: vi.fn(),
    listPublishedInformationRequestsForTimers: vi.fn(),
    expireInformationRequest: vi.fn(),
    transitionToPostIpoStructuring: vi.fn(),
    ...overrides,
  };
}

function buildTransitionService(
  overrides: Partial<PostIpoStructuringHandoffRepository> = {},
): { service: TransitionCaseToPostIpoStructuringService; handoffRepository: PostIpoStructuringHandoffRepository } {
  const handoffRepository: PostIpoStructuringHandoffRepository = {
    transitionToPostIpoStructuring: vi
      .fn()
      .mockResolvedValue({ caseId: "case_01", stage: "post_ipo_structuring" }),
    ...overrides,
  };
  return {
    service: new TransitionCaseToPostIpoStructuringService(handoffRepository, () => now),
    handoffRepository,
  };
}

describe("RetryPostIpoStructuringHandoffService", () => {
  it("404s when the case doesn't exist", async () => {
    const repository = fakeRepository({ getCaseForOperations: vi.fn().mockResolvedValue(null) });
    const { service: transitionService, handoffRepository } = buildTransitionService();
    const service = new RetryPostIpoStructuringHandoffService(repository, transitionService);

    const failure = await service
      .execute({ caseId: "case_missing", traceId: "trace_01" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: "origination.case_not_found", status: 404 });
    expect(handoffRepository.transitionToPostIpoStructuring).not.toHaveBeenCalled();
  });

  it("409s when the case has no linked offering yet", async () => {
    const repository = fakeRepository({
      getCaseForOperations: vi.fn().mockResolvedValue({ ...baseCase, offering: null }),
    });
    const { service: transitionService, handoffRepository } = buildTransitionService();
    const service = new RetryPostIpoStructuringHandoffService(repository, transitionService);

    const failure = await service
      .execute({ caseId: "case_01", traceId: "trace_01" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: "origination.post_ipo_handoff_not_ready", status: 409 });
    expect(handoffRepository.transitionToPostIpoStructuring).not.toHaveBeenCalled();
  });

  it("409s when final_offering_published_at is null -- mirroring the automatic trigger exactly", async () => {
    const repository = fakeRepository({
      getCaseForOperations: vi.fn().mockResolvedValue({
        ...baseCase,
        offering: {
          offeringId: "offering_01",
          status: "pre_offering",
          finalOfferingPublishedAt: null,
        },
      }),
    });
    const { service: transitionService, handoffRepository } = buildTransitionService();
    const service = new RetryPostIpoStructuringHandoffService(repository, transitionService);

    const failure = await service
      .execute({ caseId: "case_01", traceId: "trace_01" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: "origination.post_ipo_handoff_not_ready", status: 409 });
    expect(handoffRepository.transitionToPostIpoStructuring).not.toHaveBeenCalled();
  });

  it("delegates to the existing transition service once the guard passes", async () => {
    const repository = fakeRepository({
      getCaseForOperations: vi.fn().mockResolvedValue({
        ...baseCase,
        offering: {
          offeringId: "offering_01",
          status: "pre_offering",
          finalOfferingPublishedAt: new Date("2026-09-05T10:00:00.000Z"),
        },
      }),
    });
    const { service: transitionService, handoffRepository } = buildTransitionService();
    const service = new RetryPostIpoStructuringHandoffService(repository, transitionService);

    const result = await service.execute({ caseId: "case_01", traceId: "trace_01" });

    expect(handoffRepository.transitionToPostIpoStructuring).toHaveBeenCalledWith({
      caseId: "case_01",
      traceId: "trace_01",
      transitionedAt: now,
    });
    expect(result).toEqual({ data: { case_id: "case_01", stage: "post_ipo_structuring" } });
  });

  it("surfaces the existing transition service's own safe no-op rather than erroring", async () => {
    const repository = fakeRepository({
      getCaseForOperations: vi.fn().mockResolvedValue({
        ...baseCase,
        stage: "approved_for_final_offering",
        offering: {
          offeringId: "offering_01",
          status: "final_offering",
          finalOfferingPublishedAt: new Date("2026-09-05T10:00:00.000Z"),
        },
      }),
    });
    const { service: transitionService, handoffRepository } = buildTransitionService({
      transitionToPostIpoStructuring: vi
        .fn()
        .mockResolvedValue({ caseId: "case_01", stage: "approved_for_final_offering" }),
    });
    const service = new RetryPostIpoStructuringHandoffService(repository, transitionService);

    const result = await service.execute({ caseId: "case_01", traceId: "trace_01" });

    expect(handoffRepository.transitionToPostIpoStructuring).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: { case_id: "case_01", stage: "approved_for_final_offering" } });
  });
});

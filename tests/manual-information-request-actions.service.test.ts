import { describe, expect, it, vi } from "vitest";

import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";
import {
  ForceExpireInformationRequestService,
  SendManualReminderService,
} from "../src/modules/origination/application/operations-case.service.js";
import type {
  OperationsCaseDetail,
  OriginationRepository,
  PublishedInformationRequestForTimer,
} from "../src/modules/origination/repository/origination.repository.js";

const now = new Date("2026-09-13T12:00:00.000Z");

const publishedRequest: PublishedInformationRequestForTimer = {
  requestId: "rfi_01",
  caseId: "case_01",
  applicantAccountId: "acct_owner",
  applicantContactEmail: "owner@example.com",
  publishedAt: new Date("2026-08-31T09:00:00.000Z"),
  dueAt: new Date("2026-09-14T09:00:00.000Z"),
};

function fakeCaseDetail(overrides: Partial<OperationsCaseDetail> = {}): OperationsCaseDetail {
  return {
    caseId: "case_01",
    stage: "waiting_on_applicant",
    createdAt: new Date("2026-08-30T10:00:00.000Z"),
    updatedAt: new Date("2026-08-31T09:00:00.000Z"),
    currentRevision: null,
    property: {
      propertyId: "prop_01",
      propertyType: "residential",
      countryCode: "RS",
      city: null,
      addressLine: null,
      landRegistryReference: null,
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
    ...overrides,
  };
}

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
    getCaseForOperations: vi.fn().mockResolvedValue(null),
    getApplicantResponseWindowBusinessDays: vi.fn(),
    getInformationRequestReminderBusinessDays: vi.fn(),
    publishInformationRequest: vi.fn(),
    getOwnedInformationRequest: vi.fn(),
    listOwnedInformationRequests: vi.fn(),
    resubmitAfterInformationRequest: vi.fn(),
    recordFounderDecision: vi.fn(),
    closeCase: vi.fn(),
    reviewEvidence: vi.fn(),
    withdrawInformationRequest: vi.fn(),
    listPublishedInformationRequestsForTimers: vi.fn(),
    getPublishedInformationRequestForTimer: vi.fn().mockResolvedValue(publishedRequest),
    expireInformationRequest: vi.fn().mockResolvedValue(true),
    transitionToPostIpoStructuring: vi.fn(),
    listCaseMessages: vi.fn(),
    postCaseMessage: vi.fn(),
    getCasePartnerAssignment: vi.fn(),
    assignPartnerOrganization: vi.fn(),
    listCasesForPartner: vi.fn(),
    getCaseForPartner: vi.fn(),
    recordLegalStructuring: vi.fn(),
    recordAppraisal: vi.fn(),
    ...overrides,
  };
}

function fakeEmailSender(overrides: Partial<EmailSender> = {}): EmailSender {
  return {
    sendStaffInvitationEmail: vi.fn(),
    sendApplicantResponseReminderEmail: vi.fn().mockResolvedValue(undefined),
    sendKycRenewalReminderEmail: vi.fn(),
    sendReconfirmationReminderEmail: vi.fn(),
    sendReconfirmationWindowOpenedEmail: vi.fn(),
    sendAccountRecoveryCaseOpenedEmail: vi.fn(),
    sendAccountRecoveryApprovedEmail: vi.fn(),
    sendAccountRecoveryRejectedEmail: vi.fn(),
    sendAccountRecoveryCompletedEmail: vi.fn(),
    sendPasskeyRecoveryEmail: vi.fn(),
    ...overrides,
  };
}

describe("ForceExpireInformationRequestService", () => {
  it("force-expires a published request with a manual-override audit reason", async () => {
    const repository = fakeRepository();
    const service = new ForceExpireInformationRequestService(repository, () => now);

    const result = await service.execute({
      accountId: "acct_founder",
      caseId: "case_01",
      requestId: "rfi_01",
      traceId: "trace_1",
      body: { reason: "Applicant unresponsive after repeated outreach." },
    });

    expect(repository.expireInformationRequest).toHaveBeenCalledWith({
      requestId: "rfi_01",
      caseId: "case_01",
      traceId: "trace_1",
      expiredAt: now,
      manualOverride: {
        reason: "Applicant unresponsive after repeated outreach.",
        actorAccountId: "acct_founder",
      },
    });
    expect(result).toEqual({
      data: { request_id: "rfi_01", case_id: "case_01", status: "expired" },
    });
  });

  it("404s when the case does not exist", async () => {
    const repository = fakeRepository({
      getPublishedInformationRequestForTimer: vi.fn().mockResolvedValue(null),
      getCaseForOperations: vi.fn().mockResolvedValue(null),
    });
    const service = new ForceExpireInformationRequestService(repository, () => now);

    await expect(
      service.execute({
        accountId: "acct_founder",
        caseId: "case_missing",
        requestId: "rfi_01",
        traceId: "trace_2",
        body: { reason: "Doesn't matter." },
      }),
    ).rejects.toMatchObject({ status: 404, code: "origination.case_not_found" });
    expect(repository.expireInformationRequest).not.toHaveBeenCalled();
  });

  it("404s when the request doesn't exist on an existing case", async () => {
    const repository = fakeRepository({
      getPublishedInformationRequestForTimer: vi.fn().mockResolvedValue(null),
      getCaseForOperations: vi.fn().mockResolvedValue(fakeCaseDetail({ informationRequests: [] })),
    });
    const service = new ForceExpireInformationRequestService(repository, () => now);

    await expect(
      service.execute({
        accountId: "acct_founder",
        caseId: "case_01",
        requestId: "rfi_missing",
        traceId: "trace_3",
        body: { reason: "Doesn't matter." },
      }),
    ).rejects.toMatchObject({ status: 404, code: "origination.case_not_found" });
    expect(repository.expireInformationRequest).not.toHaveBeenCalled();
  });

  it("409s when the request exists but is no longer in a state that can be force-expired", async () => {
    const repository = fakeRepository({
      getPublishedInformationRequestForTimer: vi.fn().mockResolvedValue(null),
      getCaseForOperations: vi.fn().mockResolvedValue(
        fakeCaseDetail({
          informationRequests: [
            {
              requestId: "rfi_01",
              caseId: "case_01",
              status: "answered",
              requestBody: "Please provide a newer registry extract.",
              publishedAt: publishedRequest.publishedAt,
              dueAt: publishedRequest.dueAt,
              resolvedAt: new Date("2026-09-05T00:00:00.000Z"),
              resolutionType: "resubmitted",
              resolvingRevisionId: "rev_02",
            },
          ],
        }),
      ),
    });
    const service = new ForceExpireInformationRequestService(repository, () => now);

    await expect(
      service.execute({
        accountId: "acct_founder",
        caseId: "case_01",
        requestId: "rfi_01",
        traceId: "trace_4",
        body: { reason: "Trying to expire an already-answered request." },
      }),
    ).rejects.toMatchObject({ status: 409, code: "origination.review_transition_conflict" });
    expect(repository.expireInformationRequest).not.toHaveBeenCalled();
  });

  it("409s on a race where the repository can no longer expire the request", async () => {
    const repository = fakeRepository({ expireInformationRequest: vi.fn().mockResolvedValue(false) });
    const service = new ForceExpireInformationRequestService(repository, () => now);

    await expect(
      service.execute({
        accountId: "acct_founder",
        caseId: "case_01",
        requestId: "rfi_01",
        traceId: "trace_5",
        body: { reason: "Race condition." },
      }),
    ).rejects.toMatchObject({ status: 409, code: "origination.review_transition_conflict" });
  });
});

describe("SendManualReminderService", () => {
  it("sends the reminder email immediately, bypassing the reminder-milestone gate", async () => {
    const repository = fakeRepository();
    const emailSender = fakeEmailSender();
    const service = new SendManualReminderService(repository, emailSender);

    const result = await service.execute({ caseId: "case_01", requestId: "rfi_01" });

    expect(emailSender.sendApplicantResponseReminderEmail).toHaveBeenCalledWith({
      to: "owner@example.com",
      dueAt: publishedRequest.dueAt,
    });
    expect(result).toEqual({
      data: { request_id: "rfi_01", case_id: "case_01", sent: true },
    });
  });

  it("404s when the case does not exist", async () => {
    const repository = fakeRepository({
      getPublishedInformationRequestForTimer: vi.fn().mockResolvedValue(null),
      getCaseForOperations: vi.fn().mockResolvedValue(null),
    });
    const emailSender = fakeEmailSender();
    const service = new SendManualReminderService(repository, emailSender);

    await expect(
      service.execute({ caseId: "case_missing", requestId: "rfi_01" }),
    ).rejects.toMatchObject({ status: 404, code: "origination.case_not_found" });
    expect(emailSender.sendApplicantResponseReminderEmail).not.toHaveBeenCalled();
  });

  it("409s when the request is no longer published", async () => {
    const repository = fakeRepository({
      getPublishedInformationRequestForTimer: vi.fn().mockResolvedValue(null),
      getCaseForOperations: vi.fn().mockResolvedValue(
        fakeCaseDetail({
          informationRequests: [
            {
              requestId: "rfi_01",
              caseId: "case_01",
              status: "expired",
              requestBody: "Please provide a newer registry extract.",
              publishedAt: publishedRequest.publishedAt,
              dueAt: publishedRequest.dueAt,
              resolvedAt: new Date("2026-09-15T00:00:00.000Z"),
              resolutionType: "expired",
              resolvingRevisionId: null,
            },
          ],
        }),
      ),
    });
    const emailSender = fakeEmailSender();
    const service = new SendManualReminderService(repository, emailSender);

    await expect(
      service.execute({ caseId: "case_01", requestId: "rfi_01" }),
    ).rejects.toMatchObject({ status: 409, code: "origination.review_transition_conflict" });
    expect(emailSender.sendApplicantResponseReminderEmail).not.toHaveBeenCalled();
  });

  it("refuses to send when the applicant has no contact email on file", async () => {
    const repository = fakeRepository({
      getPublishedInformationRequestForTimer: vi
        .fn()
        .mockResolvedValue({ ...publishedRequest, applicantContactEmail: null }),
    });
    const emailSender = fakeEmailSender();
    const service = new SendManualReminderService(repository, emailSender);

    await expect(
      service.execute({ caseId: "case_01", requestId: "rfi_01" }),
    ).rejects.toMatchObject({ status: 409, code: "origination.applicant_contact_email_missing" });
    expect(emailSender.sendApplicantResponseReminderEmail).not.toHaveBeenCalled();
  });
});

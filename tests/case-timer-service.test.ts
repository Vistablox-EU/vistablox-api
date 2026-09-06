import { describe, expect, it, vi } from "vitest";

import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";
import {
  ExpireOverdueInformationRequestsService,
  SendApplicantResponseRemindersService,
} from "../src/modules/origination/application/case-timer.service.js";
import type {
  OriginationRepository,
  PublishedInformationRequestForTimer,
} from "../src/modules/origination/repository/origination.repository.js";

function request(
  overrides: Partial<PublishedInformationRequestForTimer> = {},
): PublishedInformationRequestForTimer {
  return {
    requestId: "rfi_01",
    caseId: "case_01",
    applicantAccountId: "acct_01",
    applicantContactEmail: "applicant@example.com",
    publishedAt: new Date("2026-08-31T09:00:00.000Z"),
    dueAt: new Date("2026-09-14T09:00:00.000Z"),
    ...overrides,
  };
}

function repository(overrides: Partial<OriginationRepository> = {}): OriginationRepository {
  return {
    getIntakePrerequisites: vi.fn(),
    createDraftIntake: vi.fn(),
    listOwnedCases: vi.fn(),
    getOwnedCase: vi.fn(),
    submitInitialCase: vi.fn(),
    listCasesForOperations: vi.fn(),
    getCaseForOperations: vi.fn(),
    getApplicantResponseWindowBusinessDays: vi.fn(),
    getInformationRequestReminderBusinessDays: vi.fn().mockResolvedValue([3, 7]),
    publishInformationRequest: vi.fn(),
    getOwnedInformationRequest: vi.fn(),
    listOwnedInformationRequests: vi.fn(),
    resubmitAfterInformationRequest: vi.fn(),
    recordFounderDecision: vi.fn(),
    listPublishedInformationRequestsForTimers: vi.fn().mockResolvedValue([]),
    expireInformationRequest: vi.fn().mockResolvedValue(true),
    closeCase: vi.fn(),
    listCaseMessages: vi.fn().mockResolvedValue([]),
    postCaseMessage: vi.fn(),
    ...overrides,
  };
}

function emailSender(overrides: Partial<EmailSender> = {}): EmailSender {
  return {
    sendPasskeyRecoveryEmail: vi.fn(),
    sendStaffInvitationEmail: vi.fn(),
    sendApplicantResponseReminderEmail: vi.fn().mockResolvedValue(undefined),
    sendKycRenewalReminderEmail: vi.fn(),
    sendReconfirmationReminderEmail: vi.fn(),
    sendReconfirmationWindowOpenedEmail: vi.fn(),
    sendAccountRecoveryCaseOpenedEmail: vi.fn(),
    sendAccountRecoveryApprovedEmail: vi.fn(),
    sendAccountRecoveryRejectedEmail: vi.fn(),
    sendAccountRecoveryCompletedEmail: vi.fn(),
    ...overrides,
  };
}

describe("SendApplicantResponseRemindersService", () => {
  it("emails only requests whose reminder milestone matches today", async () => {
    const dueToday = request({ requestId: "rfi_due", publishedAt: new Date("2026-08-31T09:00:00.000Z") });
    const notDueToday = request({
      requestId: "rfi_not_due",
      publishedAt: new Date("2026-08-20T09:00:00.000Z"),
    });
    const email = emailSender();
    const service = new SendApplicantResponseRemindersService(
      repository({
        listPublishedInformationRequestsForTimers: vi
          .fn()
          .mockResolvedValue([dueToday, notDueToday]),
      }),
      email,
      () => new Date("2026-09-03T00:00:00.000Z"),
    );

    const summary = await service.execute();

    expect(email.sendApplicantResponseReminderEmail).toHaveBeenCalledTimes(1);
    expect(email.sendApplicantResponseReminderEmail).toHaveBeenCalledWith({
      to: "applicant@example.com",
      dueAt: dueToday.dueAt,
    });
    expect(summary).toEqual({ checked: 2, acted: 1 });
  });

  it("skips a request with no contact email on file rather than failing the run", async () => {
    const email = emailSender();
    const service = new SendApplicantResponseRemindersService(
      repository({
        listPublishedInformationRequestsForTimers: vi
          .fn()
          .mockResolvedValue([request({ applicantContactEmail: null })]),
      }),
      email,
      () => new Date("2026-09-03T00:00:00.000Z"),
    );

    const summary = await service.execute();

    expect(email.sendApplicantResponseReminderEmail).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });
});

describe("ExpireOverdueInformationRequestsService", () => {
  it("expires only requests past their due date", async () => {
    const overdue = request({ requestId: "rfi_overdue", dueAt: new Date("2026-09-01T00:00:00.000Z") });
    const notYetDue = request({
      requestId: "rfi_pending",
      dueAt: new Date("2026-09-10T00:00:00.000Z"),
    });
    const expireInformationRequest = vi.fn().mockResolvedValue(true);
    const service = new ExpireOverdueInformationRequestsService(
      repository({
        listPublishedInformationRequestsForTimers: vi
          .fn()
          .mockResolvedValue([overdue, notYetDue]),
        expireInformationRequest,
      }),
      () => new Date("2026-09-03T00:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(expireInformationRequest).toHaveBeenCalledTimes(1);
    expect(expireInformationRequest).toHaveBeenCalledWith({
      requestId: "rfi_overdue",
      caseId: overdue.caseId,
      traceId: "req_trace_01",
      expiredAt: new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(summary).toEqual({ checked: 2, acted: 1 });
  });

  it("does not count a request the repository could not expire due to a concurrent change", async () => {
    const service = new ExpireOverdueInformationRequestsService(
      repository({
        listPublishedInformationRequestsForTimers: vi
          .fn()
          .mockResolvedValue([request({ dueAt: new Date("2026-09-01T00:00:00.000Z") })]),
        expireInformationRequest: vi.fn().mockResolvedValue(false),
      }),
      () => new Date("2026-09-03T00:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(summary).toEqual({ checked: 1, acted: 0 });
  });
});

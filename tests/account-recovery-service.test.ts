import { describe, expect, it, vi } from "vitest";

import {
  CompleteAccountRecoveryService,
  CreateRecoveryDiditSessionService,
  DecideAccountRecoveryCaseService,
  GetAccountRecoveryCaseService,
  OpenAccountRecoveryCaseService,
  RecordPrimaryRecoveryReviewService,
} from "../src/modules/auth/application/account-recovery.service.js";
import type { CustomerAccountAdministrator } from "../src/modules/auth/application/customer-account-administrator.js";
import type {
  AccountRecoveryCaseRecord,
  AccountRecoveryRepository,
  RecoveryCaseTarget,
} from "../src/modules/auth/repository/account-recovery.repository.js";
import type { DiditClient } from "../src/modules/identity/application/didit-client.js";
import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";

const accountId = "acct_customer_01";
const caseId = "recovery_case_01";
const now = new Date("2026-09-02T12:00:00.000Z");

function caseRecord(overrides: Partial<AccountRecoveryCaseRecord> = {}): AccountRecoveryCaseRecord {
  return {
    id: caseId,
    accountId,
    status: "open",
    freshDiditVerificationRef: null,
    reviewedByPrimary: null,
    reviewedBySecondary: null,
    cooldownEndsAt: null,
    createdAt: now,
    resolvedAt: null,
    ...overrides,
  };
}

function target(overrides: Partial<RecoveryCaseTarget> = {}): RecoveryCaseTarget {
  return {
    accountId,
    betterAuthUserId: "better_auth_user_01",
    status: "active",
    contactEmail: "investor@example.com",
    isStaff: false,
    ...overrides,
  };
}

function repository(overrides: Partial<AccountRecoveryRepository> = {}): AccountRecoveryRepository {
  return {
    findTargetForRecovery: vi.fn().mockResolvedValue(target()),
    findOpenCaseForAccount: vi.fn().mockResolvedValue(null),
    findCase: vi.fn().mockResolvedValue(caseRecord()),
    openCase: vi.fn().mockResolvedValue(caseRecord()),
    recordDiditSession: vi.fn().mockResolvedValue(caseRecord({ freshDiditVerificationRef: "didit_ref_01" })),
    getCorroborationFacts: vi.fn().mockResolvedValue({
      lastDeposit: null,
      lastReservation: null,
      lastLogin: null,
    }),
    recordPrimaryReview: vi.fn().mockResolvedValue(caseRecord({ reviewedByPrimary: "acct_reviewer_01" })),
    decideCase: vi.fn().mockResolvedValue(
      caseRecord({
        status: "approved",
        reviewedByPrimary: "acct_reviewer_01",
        reviewedBySecondary: "acct_reviewer_02",
        resolvedAt: now,
      }),
    ),
    completeCase: vi.fn().mockResolvedValue(
      caseRecord({
        status: "completed",
        reviewedByPrimary: "acct_reviewer_01",
        reviewedBySecondary: "acct_reviewer_02",
        resolvedAt: now,
        cooldownEndsAt: new Date(now.getTime() + 72 * 60 * 60 * 1000),
      }),
    ),
    getActiveCooldown: vi.fn().mockResolvedValue(null),
    revokeDevicesForRecovery: vi.fn().mockResolvedValue({
      revokedDeviceIds: ["device_01"],
      removedLoginMethodCount: 1,
    }),
    recordRecoveryAuditEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function administrator(overrides: Partial<CustomerAccountAdministrator> = {}): CustomerAccountAdministrator {
  return {
    revokeAllSessions: vi.fn().mockResolvedValue(undefined),
    sendRecoveryCompletionEmail: vi.fn().mockResolvedValue(undefined),
    prepareSelfServicePasskeyReplacement: vi.fn().mockResolvedValue("bootstrap_context"),
    revokeSessionsForRecoveryCompletion: vi
      .fn()
      .mockResolvedValue({ revokedSessionCount: 2, deviceSessionCount: 1 }),
    clearRecoveryRequired: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function emailSender(overrides: Partial<EmailSender> = {}): EmailSender {
  return {
    sendPasskeyRecoveryEmail: vi.fn().mockResolvedValue(undefined),
    sendStaffInvitationEmail: vi.fn().mockResolvedValue(undefined),
    sendApplicantResponseReminderEmail: vi.fn().mockResolvedValue(undefined),
    sendKycRenewalReminderEmail: vi.fn().mockResolvedValue(undefined),
    sendReconfirmationReminderEmail: vi.fn().mockResolvedValue(undefined),
    sendReconfirmationWindowOpenedEmail: vi.fn().mockResolvedValue(undefined),
    sendAccountRecoveryCaseOpenedEmail: vi.fn().mockResolvedValue(undefined),
    sendAccountRecoveryApprovedEmail: vi.fn().mockResolvedValue(undefined),
    sendAccountRecoveryRejectedEmail: vi.fn().mockResolvedValue(undefined),
    sendAccountRecoveryCompletedEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function didit(overrides: Partial<DiditClient> = {}): DiditClient {
  return {
    createSession: vi.fn().mockResolvedValue({
      sessionId: "didit_ref_01",
      verificationUrl: "https://verify.didit.me/session/didit_ref_01",
      status: "Not Started",
      workflowId: "workflow_01",
      vendorData: accountId,
    }),
    getDecision: vi.fn().mockResolvedValue({
      sessionId: "didit_ref_01",
      sessionKind: "user",
      workflowId: "workflow_01",
      vendorData: accountId,
      status: "Approved",
      idVerifications: [],
      livenessChecks: [],
      faceMatches: [],
      amlScreenings: [],
      proofOfAddressVerifications: [],
      verifiedDisplayProfile: null,
    }),
    ...overrides,
  };
}

describe("OpenAccountRecoveryCaseService", () => {
  it("revokes existing sessions, opens the case, and notifies the verified contact email", async () => {
    const revokeAllSessions = vi.fn().mockResolvedValue(undefined);
    const sendAccountRecoveryCaseOpenedEmail = vi.fn().mockResolvedValue(undefined);
    const openCase = vi.fn().mockResolvedValue(caseRecord());
    const service = new OpenAccountRecoveryCaseService(
      repository({ openCase }),
      administrator({ revokeAllSessions }),
      emailSender({ sendAccountRecoveryCaseOpenedEmail }),
      () => now,
    );

    const result = await service.execute({
      accountId,
      actorAccountId: "acct_staff_01",
      traceId: "trace_01",
    });

    expect(revokeAllSessions).toHaveBeenCalledWith("better_auth_user_01");
    expect(openCase).toHaveBeenCalledWith({
      accountId,
      actorAccountId: "acct_staff_01",
      traceId: "trace_01",
      openedAt: now,
    });
    expect(sendAccountRecoveryCaseOpenedEmail).toHaveBeenCalledWith({ to: "investor@example.com" });
    expect(result).toEqual(caseRecord());
  });

  it("rejects when the target account does not exist", async () => {
    const service = new OpenAccountRecoveryCaseService(
      repository({ findTargetForRecovery: vi.fn().mockResolvedValue(null) }),
      administrator(),
      emailSender(),
    );

    await expect(
      service.execute({ accountId, actorAccountId: "acct_staff_01", traceId: "trace_01" }),
    ).rejects.toMatchObject({ code: "authentication.account_recovery_target_not_found" });
  });

  it("rejects a staff target, pointing to the staff recovery flow instead", async () => {
    const service = new OpenAccountRecoveryCaseService(
      repository({ findTargetForRecovery: vi.fn().mockResolvedValue(target({ isStaff: true })) }),
      administrator(),
      emailSender(),
    );

    await expect(
      service.execute({ accountId, actorAccountId: "acct_staff_01", traceId: "trace_01" }),
    ).rejects.toMatchObject({ code: "authentication.account_recovery_target_is_staff" });
  });

  it("rejects a target that is not currently active", async () => {
    const service = new OpenAccountRecoveryCaseService(
      repository({
        findTargetForRecovery: vi.fn().mockResolvedValue(target({ status: "recovery_review" })),
      }),
      administrator(),
      emailSender(),
    );

    await expect(
      service.execute({ accountId, actorAccountId: "acct_staff_01", traceId: "trace_01" }),
    ).rejects.toMatchObject({ code: "authentication.account_recovery_target_not_active" });
  });

  it("rejects when the account already has an open case", async () => {
    const service = new OpenAccountRecoveryCaseService(
      repository({ findOpenCaseForAccount: vi.fn().mockResolvedValue(caseRecord()) }),
      administrator(),
      emailSender(),
    );

    await expect(
      service.execute({ accountId, actorAccountId: "acct_staff_01", traceId: "trace_01" }),
    ).rejects.toMatchObject({ code: "authentication.account_recovery_case_already_open" });
  });

  it("does not fail the request when the case-opened notification cannot be delivered", async () => {
    const service = new OpenAccountRecoveryCaseService(
      repository(),
      administrator(),
      emailSender({
        sendAccountRecoveryCaseOpenedEmail: vi.fn().mockRejectedValue(new Error("smtp down")),
      }),
    );

    await expect(
      service.execute({ accountId, actorAccountId: "acct_staff_01", traceId: "trace_01" }),
    ).resolves.toEqual(caseRecord());
  });
});

describe("CreateRecoveryDiditSessionService", () => {
  it("creates a Didit session tagged for account recovery and records the reference", async () => {
    const createSession = vi.fn().mockResolvedValue({
      sessionId: "didit_ref_01",
      verificationUrl: "https://verify.didit.me/session/didit_ref_01",
      status: "Not Started",
      workflowId: "workflow_01",
      vendorData: accountId,
    });
    const recordDiditSession = vi.fn().mockResolvedValue(
      caseRecord({ freshDiditVerificationRef: "didit_ref_01" }),
    );
    const service = new CreateRecoveryDiditSessionService(
      repository({ recordDiditSession }),
      didit({ createSession }),
      { workflowId: "workflow_01", callbackUrl: "https://api.vistablox.io/webhooks/didit" },
      () => now,
    );

    const result = await service.execute({
      caseId,
      actorAccountId: "acct_staff_01",
      traceId: "trace_01",
    });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "workflow_01",
        accountId,
        purpose: "account_recovery",
      }),
    );
    expect(recordDiditSession).toHaveBeenCalledWith(
      expect.objectContaining({ caseId, diditReference: "didit_ref_01" }),
    );
    expect(result.verificationUrl).toBe("https://verify.didit.me/session/didit_ref_01");
  });

  it("rejects when the case is not open", async () => {
    const service = new CreateRecoveryDiditSessionService(
      repository({ findCase: vi.fn().mockResolvedValue(caseRecord({ status: "approved" })) }),
      didit(),
      { workflowId: "workflow_01", callbackUrl: "https://api.vistablox.io/webhooks/didit" },
    );

    await expect(
      service.execute({ caseId, actorAccountId: "acct_staff_01", traceId: "trace_01" }),
    ).rejects.toMatchObject({ code: "authentication.account_recovery_case_not_open" });
  });
});

describe("GetAccountRecoveryCaseService", () => {
  it("re-queries the live Didit decision and returns it alongside corroboration facts", async () => {
    const getDecision = vi.fn().mockResolvedValue({
      sessionId: "didit_ref_01",
      sessionKind: "user",
      workflowId: "workflow_01",
      vendorData: accountId,
      status: "Approved",
      idVerifications: [],
      livenessChecks: [],
      faceMatches: [],
      amlScreenings: [],
      proofOfAddressVerifications: [],
      verifiedDisplayProfile: null,
    });
    const service = new GetAccountRecoveryCaseService(
      repository({
        findCase: vi.fn().mockResolvedValue(caseRecord({ freshDiditVerificationRef: "didit_ref_01" })),
      }),
      didit({ getDecision }),
    );

    const result = await service.execute(caseId);

    expect(getDecision).toHaveBeenCalledWith("didit_ref_01");
    expect(result.freshDiditVerificationStatus).toBe("Approved");
  });

  it("reports a null Didit status when no verification session has been created yet", async () => {
    const getDecision = vi.fn();
    const service = new GetAccountRecoveryCaseService(repository(), didit({ getDecision }));

    const result = await service.execute(caseId);

    expect(getDecision).not.toHaveBeenCalled();
    expect(result.freshDiditVerificationStatus).toBeNull();
  });

  it("rejects when the case does not exist", async () => {
    const service = new GetAccountRecoveryCaseService(
      repository({ findCase: vi.fn().mockResolvedValue(null) }),
      didit(),
    );

    await expect(service.execute(caseId)).rejects.toMatchObject({
      code: "authentication.account_recovery_case_not_found",
    });
  });
});

describe("RecordPrimaryRecoveryReviewService", () => {
  it("records the primary review and corroboration category", async () => {
    const recordPrimaryReview = vi.fn().mockResolvedValue(
      caseRecord({ reviewedByPrimary: "acct_reviewer_01" }),
    );
    const service = new RecordPrimaryRecoveryReviewService(repository({ recordPrimaryReview }), () => now);

    await service.execute({
      caseId,
      actorAccountId: "acct_reviewer_01",
      traceId: "trace_01",
      corroborationCategory: "recent_deposit",
    });

    expect(recordPrimaryReview).toHaveBeenCalledWith({
      caseId,
      reviewerAccountId: "acct_reviewer_01",
      corroborationCategory: "recent_deposit",
      traceId: "trace_01",
      reviewedAt: now,
    });
  });

  it("rejects when the repository reports the preconditions were not met", async () => {
    const service = new RecordPrimaryRecoveryReviewService(
      repository({ recordPrimaryReview: vi.fn().mockResolvedValue(null) }),
    );

    await expect(
      service.execute({
        caseId,
        actorAccountId: "acct_reviewer_01",
        traceId: "trace_01",
        corroborationCategory: "recent_deposit",
      }),
    ).rejects.toMatchObject({ code: "authentication.account_recovery_primary_review_unavailable" });
  });
});

describe("DecideAccountRecoveryCaseService", () => {
  it("approves the case and notifies the account of the approval", async () => {
    const sendAccountRecoveryApprovedEmail = vi.fn().mockResolvedValue(undefined);
    const sendAccountRecoveryRejectedEmail = vi.fn().mockResolvedValue(undefined);
    const service = new DecideAccountRecoveryCaseService(
      repository({ findCase: vi.fn().mockResolvedValue(caseRecord({ reviewedByPrimary: "acct_reviewer_01" })) }),
      emailSender({ sendAccountRecoveryApprovedEmail, sendAccountRecoveryRejectedEmail }),
      () => now,
    );

    await service.execute({
      caseId,
      actorAccountId: "acct_reviewer_02",
      traceId: "trace_01",
      decision: "approved",
      reason: "Evidence checks out.",
    });

    expect(sendAccountRecoveryApprovedEmail).toHaveBeenCalledWith({ to: "investor@example.com" });
    expect(sendAccountRecoveryRejectedEmail).not.toHaveBeenCalled();
  });

  it("rejects the case and notifies the account of the rejection", async () => {
    const sendAccountRecoveryRejectedEmail = vi.fn().mockResolvedValue(undefined);
    const decideCase = vi.fn().mockResolvedValue(
      caseRecord({ status: "rejected", reviewedByPrimary: "acct_reviewer_01", reviewedBySecondary: "acct_reviewer_02" }),
    );
    const service = new DecideAccountRecoveryCaseService(
      repository({
        findCase: vi.fn().mockResolvedValue(caseRecord({ reviewedByPrimary: "acct_reviewer_01" })),
        decideCase,
      }),
      emailSender({ sendAccountRecoveryRejectedEmail }),
    );

    await service.execute({
      caseId,
      actorAccountId: "acct_reviewer_02",
      traceId: "trace_01",
      decision: "rejected",
      reason: "Corroboration did not match.",
    });

    expect(decideCase).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "rejected", reviewerAccountId: "acct_reviewer_02" }),
    );
    expect(sendAccountRecoveryRejectedEmail).toHaveBeenCalledWith({ to: "investor@example.com" });
  });

  it("rejects when the deciding reviewer is the same as the primary reviewer", async () => {
    const decideCase = vi.fn();
    const service = new DecideAccountRecoveryCaseService(
      repository({
        findCase: vi.fn().mockResolvedValue(caseRecord({ reviewedByPrimary: "acct_reviewer_01" })),
        decideCase,
      }),
      emailSender(),
    );

    await expect(
      service.execute({
        caseId,
        actorAccountId: "acct_reviewer_01",
        traceId: "trace_01",
        decision: "approved",
        reason: "Looks fine.",
      }),
    ).rejects.toMatchObject({ code: "authentication.account_recovery_same_reviewer" });
    expect(decideCase).not.toHaveBeenCalled();
  });
});

describe("CompleteAccountRecoveryService", () => {
  it("customer target: revokes devices and device_key rows, ends sessions, clears the flag, completes the case, then sends a no-link re-enrolment notice", async () => {
    const revokeDevicesForRecovery = vi.fn().mockResolvedValue({
      revokedDeviceIds: ["device_01"],
      removedLoginMethodCount: 1,
    });
    const revokeSessionsForRecoveryCompletion = vi
      .fn()
      .mockResolvedValue({ revokedSessionCount: 2, deviceSessionCount: 1 });
    const clearRecoveryRequired = vi.fn().mockResolvedValue(undefined);
    const recordRecoveryAuditEvent = vi.fn().mockResolvedValue(undefined);
    const completeCase = vi.fn().mockResolvedValue(
      caseRecord({ status: "completed", cooldownEndsAt: new Date(now.getTime() + 72 * 60 * 60 * 1000) }),
    );
    const sendRecoveryCompletionEmail = vi.fn();
    const sendAccountRecoveryCompletedEmail = vi.fn().mockResolvedValue(undefined);
    const service = new CompleteAccountRecoveryService(
      repository({
        findCase: vi.fn().mockResolvedValue(caseRecord({ status: "approved" })),
        findTargetForRecovery: vi.fn().mockResolvedValue(target({ isStaff: false })),
        revokeDevicesForRecovery,
        recordRecoveryAuditEvent,
        completeCase,
      }),
      administrator({ sendRecoveryCompletionEmail, revokeSessionsForRecoveryCompletion, clearRecoveryRequired }),
      emailSender({ sendAccountRecoveryCompletedEmail }),
      "https://app.vistablox.io/recover-account",
      () => now,
    );

    const result = await service.execute({ caseId, actorAccountId: "acct_staff_01", traceId: "trace_01" });

    expect(result.status).toBe("completed");
    expect(revokeDevicesForRecovery).toHaveBeenCalledWith({
      caseId,
      accountId,
      actorAccountId: "acct_staff_01",
      traceId: "trace_01",
      revokedAt: now,
    });
    expect(revokeSessionsForRecoveryCompletion).toHaveBeenCalledWith("better_auth_user_01");
    expect(clearRecoveryRequired).toHaveBeenCalledWith("better_auth_user_01");
    expect(completeCase).toHaveBeenCalledWith({
      caseId,
      actorAccountId: "acct_staff_01",
      traceId: "trace_01",
      completedAt: now,
      cooldownEndsAt: new Date(now.getTime() + 72 * 60 * 60 * 1000),
    });
    // Devices first, then sessions, then the flag, and only then the case.
    const order = (mock: ReturnType<typeof vi.fn>) => mock.mock.invocationCallOrder[0] as number;
    expect(order(revokeDevicesForRecovery)).toBeLessThan(order(revokeSessionsForRecoveryCompletion));
    expect(order(revokeSessionsForRecoveryCompletion)).toBeLessThan(order(clearRecoveryRequired));
    expect(order(clearRecoveryRequired)).toBeLessThan(order(completeCase));
    // No passkey link: the customer re-enrols through Google/Apple and E1/E2.
    expect(sendRecoveryCompletionEmail).not.toHaveBeenCalled();
    expect(sendAccountRecoveryCompletedEmail).toHaveBeenCalledWith({
      to: "investor@example.com",
      cooldownEndsAt: new Date(now.getTime() + 72 * 60 * 60 * 1000),
      deviceReenrolmentRequired: true,
    });
    const audited = recordRecoveryAuditEvent.mock.calls.map((call) => (call[0] as { action: string }).action);
    expect(audited).toEqual([
      "authentication.account_recovery_sessions_revoked",
      "authentication.account_recovery_restriction_cleared",
      "authentication.account_recovery_reenrolment_notice",
    ]);
    expect(recordRecoveryAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      changes: { revoked_device_count: 1, revoked_session_count: 2, revoked_device_session_count: 1 },
    });
    expect(recordRecoveryAuditEvent.mock.calls[2]?.[0]).toMatchObject({ changes: { outcome: "sent" } });
  });

  it("customer target: a failure before completion is retry-safe (503) and leaves the case approved", async () => {
    const completeCase = vi.fn();
    const clearRecoveryRequired = vi.fn();
    const service = new CompleteAccountRecoveryService(
      repository({
        findCase: vi.fn().mockResolvedValue(caseRecord({ status: "approved" })),
        findTargetForRecovery: vi.fn().mockResolvedValue(target({ isStaff: false })),
        completeCase,
      }),
      administrator({
        revokeSessionsForRecoveryCompletion: vi.fn().mockRejectedValue(new Error("auth store down")),
        clearRecoveryRequired,
      }),
      emailSender(),
      "https://app.vistablox.io/recover-account",
      () => now,
    );

    await expect(
      service.execute({ caseId, actorAccountId: "acct_staff_01", traceId: "trace_01" }),
    ).rejects.toMatchObject({ code: "authentication.account_recovery_completion_failed", status: 503 });
    expect(clearRecoveryRequired).not.toHaveBeenCalled();
    expect(completeCase).not.toHaveBeenCalled();
  });

  it("customer target: the case stays completed when the notice can't be sent, and the failure is audited", async () => {
    const recordRecoveryAuditEvent = vi.fn().mockResolvedValue(undefined);
    const service = new CompleteAccountRecoveryService(
      repository({
        findCase: vi.fn().mockResolvedValue(caseRecord({ status: "approved" })),
        findTargetForRecovery: vi.fn().mockResolvedValue(target({ isStaff: false })),
        recordRecoveryAuditEvent,
      }),
      administrator(),
      emailSender({ sendAccountRecoveryCompletedEmail: vi.fn().mockRejectedValue(new Error("smtp down")) }),
      "https://app.vistablox.io/recover-account",
      () => now,
    );

    const result = await service.execute({ caseId, actorAccountId: "acct_staff_01", traceId: "trace_01" });

    expect(result.status).toBe("completed");
    expect(recordRecoveryAuditEvent.mock.calls.at(-1)?.[0]).toMatchObject({
      action: "authentication.account_recovery_reenrolment_notice",
      changes: { outcome: "failed" },
    });
  });

  it("staff target: never touches devices, sessions or the flag through the customer path", async () => {
    const revokeDevicesForRecovery = vi.fn();
    const revokeSessionsForRecoveryCompletion = vi.fn();
    const clearRecoveryRequired = vi.fn();
    const service = new CompleteAccountRecoveryService(
      repository({
        findCase: vi.fn().mockResolvedValue(caseRecord({ status: "approved" })),
        findTargetForRecovery: vi.fn().mockResolvedValue(target({ isStaff: true })),
        revokeDevicesForRecovery,
      }),
      administrator({ revokeSessionsForRecoveryCompletion, clearRecoveryRequired }),
      emailSender(),
      "https://app.vistablox.io/recover-account",
      () => now,
    );

    await service.execute({ caseId, actorAccountId: "acct_staff_01", traceId: "trace_01" });

    expect(revokeDevicesForRecovery).not.toHaveBeenCalled();
    expect(revokeSessionsForRecoveryCompletion).not.toHaveBeenCalled();
    expect(clearRecoveryRequired).not.toHaveBeenCalled();
  });

  it("staff target, unchanged: sends the recovery completion email, completes the case with a 72-hour cooldown, and sends the FYI notification", async () => {
    const sendRecoveryCompletionEmail = vi.fn().mockResolvedValue(undefined);
    const sendAccountRecoveryCompletedEmail = vi.fn().mockResolvedValue(undefined);
    const completeCase = vi.fn().mockResolvedValue(
      caseRecord({ status: "completed", cooldownEndsAt: new Date(now.getTime() + 72 * 60 * 60 * 1000) }),
    );
    const service = new CompleteAccountRecoveryService(
      repository({
        findCase: vi.fn().mockResolvedValue(caseRecord({ status: "approved" })),
        findTargetForRecovery: vi.fn().mockResolvedValue(target({ isStaff: true })),
        completeCase,
      }),
      administrator({ sendRecoveryCompletionEmail }),
      emailSender({ sendAccountRecoveryCompletedEmail }),
      "https://app.vistablox.io/recover-account",
      () => now,
    );

    await service.execute({ caseId, actorAccountId: "acct_staff_01", traceId: "trace_01" });

    expect(sendRecoveryCompletionEmail).toHaveBeenCalledWith({
      betterAuthUserId: "better_auth_user_01",
      redirectTo: "https://app.vistablox.io/recover-account",
      traceId: "trace_01",
    });
    expect(completeCase).toHaveBeenCalledWith({
      caseId,
      actorAccountId: "acct_staff_01",
      traceId: "trace_01",
      completedAt: now,
      cooldownEndsAt: new Date(now.getTime() + 72 * 60 * 60 * 1000),
    });
    expect(sendAccountRecoveryCompletedEmail).toHaveBeenCalledWith({
      to: "investor@example.com",
      cooldownEndsAt: new Date(now.getTime() + 72 * 60 * 60 * 1000),
    });
  });

  it("rejects when the case is not approved", async () => {
    const service = new CompleteAccountRecoveryService(
      repository({ findCase: vi.fn().mockResolvedValue(caseRecord({ status: "open" })) }),
      administrator(),
      emailSender(),
      "https://app.vistablox.io/recover-account",
    );

    await expect(
      service.execute({ caseId, actorAccountId: "acct_staff_01", traceId: "trace_01" }),
    ).rejects.toMatchObject({ code: "authentication.account_recovery_case_not_approved" });
  });

  it("surfaces a retry-safe error and does not complete the case when the completion email fails to send", async () => {
    const completeCase = vi.fn();
    const service = new CompleteAccountRecoveryService(
      repository({
        findCase: vi.fn().mockResolvedValue(caseRecord({ status: "approved" })),
        findTargetForRecovery: vi.fn().mockResolvedValue(target({ isStaff: true })),
        completeCase,
      }),
      administrator({ sendRecoveryCompletionEmail: vi.fn().mockRejectedValue(new Error("smtp down")) }),
      emailSender(),
      "https://app.vistablox.io/recover-account",
    );

    await expect(
      service.execute({ caseId, actorAccountId: "acct_staff_01", traceId: "trace_01" }),
    ).rejects.toMatchObject({ code: "authentication.account_recovery_completion_delivery_failed" });
    expect(completeCase).not.toHaveBeenCalled();
  });
});

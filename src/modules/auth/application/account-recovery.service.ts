import { randomUUID } from "node:crypto";

import { AppError } from "../../../shared/errors/app-error.js";
import type { EmailSender } from "../../../infrastructure/email/smtp-email-sender.js";
import type { DiditClient } from "../../identity/application/didit-client.js";
import type {
  AccountRecoveryCaseRecord,
  AccountRecoveryRepository,
  RecoveryCorroborationCategory,
  RecoveryCorroborationFacts,
} from "../repository/account-recovery.repository.js";
import type { CustomerAccountAdministrator } from "./customer-account-administrator.js";

const RECOVERY_COOLDOWN_HOURS = 72;

export class OpenAccountRecoveryCaseService {
  public constructor(
    private readonly repository: AccountRecoveryRepository,
    private readonly administrator: CustomerAccountAdministrator,
    private readonly emailSender: EmailSender,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
  }): Promise<AccountRecoveryCaseRecord> {
    const target = await this.repository.findTargetForRecovery(input.accountId);
    if (target === null) throw targetNotFoundError();
    if (target.isStaff) throw targetIsStaffError();
    if (target.status !== "active") throw targetNotActiveError();

    const existingOpenCase = await this.repository.findOpenCaseForAccount(input.accountId);
    if (existingOpenCase !== null) throw caseAlreadyOpenError();

    const openedAt = this.clock();
    // Kill live access first, then record the case — closes the window during
    // which a still-valid session could act before the restriction is durable.
    await this.administrator.revokeAllSessions(target.betterAuthUserId);
    const created = await this.repository.openCase({
      accountId: input.accountId,
      actorAccountId: input.actorAccountId,
      traceId: input.traceId,
      openedAt,
    });

    if (target.contactEmail !== null) {
      try {
        await this.emailSender.sendAccountRecoveryCaseOpenedEmail({ to: target.contactEmail });
      } catch {
        // Best-effort: this is a security FYI, not the recovery mechanism
        // itself — access is already revoked and the case is already open
        // regardless of whether this notification lands.
      }
    }

    return created;
  }
}

export class CreateRecoveryDiditSessionService {
  public constructor(
    private readonly repository: AccountRecoveryRepository,
    private readonly didit: DiditClient,
    private readonly config: { workflowId: string; callbackUrl: string },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    caseId: string;
    actorAccountId: string;
    traceId: string;
  }): Promise<{ verificationUrl: string; case: AccountRecoveryCaseRecord }> {
    const existingCase = await this.repository.findCase(input.caseId);
    if (existingCase === null || existingCase.status !== "open") throw caseNotOpenError();

    const session = await this.didit.createSession({
      workflowId: this.config.workflowId,
      accountId: existingCase.accountId,
      callbackUrl: this.config.callbackUrl,
      sessionStartId: `recovery_${randomUUID()}`,
      purpose: "account_recovery",
    });
    const updated = await this.repository.recordDiditSession({
      caseId: input.caseId,
      diditReference: session.sessionId,
      actorAccountId: input.actorAccountId,
      traceId: input.traceId,
      recordedAt: this.clock(),
    });
    if (updated === null) throw caseNotOpenError();

    return { verificationUrl: session.verificationUrl, case: updated };
  }
}

export class GetAccountRecoveryCaseService {
  public constructor(
    private readonly repository: AccountRecoveryRepository,
    private readonly didit: DiditClient,
  ) {}

  public async execute(caseId: string): Promise<{
    case: AccountRecoveryCaseRecord;
    freshDiditVerificationStatus: string | null;
    corroborationFacts: RecoveryCorroborationFacts;
  }> {
    const existingCase = await this.repository.findCase(caseId);
    if (existingCase === null) throw caseNotFoundError();

    const [freshDiditVerificationStatus, corroborationFacts] = await Promise.all([
      existingCase.freshDiditVerificationRef === null
        ? Promise.resolve(null)
        : this.didit
            .getDecision(existingCase.freshDiditVerificationRef)
            .then((decision) => decision.status),
      this.repository.getCorroborationFacts(existingCase.accountId),
    ]);

    return { case: existingCase, freshDiditVerificationStatus, corroborationFacts };
  }
}

export class RecordPrimaryRecoveryReviewService {
  public constructor(
    private readonly repository: AccountRecoveryRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    caseId: string;
    actorAccountId: string;
    traceId: string;
    corroborationCategory: RecoveryCorroborationCategory;
  }): Promise<AccountRecoveryCaseRecord> {
    const updated = await this.repository.recordPrimaryReview({
      caseId: input.caseId,
      reviewerAccountId: input.actorAccountId,
      corroborationCategory: input.corroborationCategory,
      traceId: input.traceId,
      reviewedAt: this.clock(),
    });
    if (updated === null) throw primaryReviewUnavailableError();
    return updated;
  }
}

export class DecideAccountRecoveryCaseService {
  public constructor(
    private readonly repository: AccountRecoveryRepository,
    private readonly emailSender: EmailSender,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    caseId: string;
    actorAccountId: string;
    traceId: string;
    decision: "approved" | "rejected";
    reason: string;
  }): Promise<AccountRecoveryCaseRecord> {
    const existingCase = await this.repository.findCase(input.caseId);
    if (existingCase === null) throw caseNotFoundError();
    if (existingCase.reviewedByPrimary === input.actorAccountId) throw sameReviewerError();

    const updated = await this.repository.decideCase({
      caseId: input.caseId,
      reviewerAccountId: input.actorAccountId,
      decision: input.decision,
      reason: input.reason,
      traceId: input.traceId,
      decidedAt: this.clock(),
    });
    if (updated === null) throw decisionUnavailableError();

    const target = await this.repository.findTargetForRecovery(updated.accountId);
    if (target?.contactEmail != null) {
      try {
        if (input.decision === "approved") {
          await this.emailSender.sendAccountRecoveryApprovedEmail({ to: target.contactEmail });
        } else {
          await this.emailSender.sendAccountRecoveryRejectedEmail({ to: target.contactEmail });
        }
      } catch {
        // Best-effort notification — the decision itself is already durable.
      }
    }

    return updated;
  }
}

export class CompleteAccountRecoveryService {
  public constructor(
    private readonly repository: AccountRecoveryRepository,
    private readonly administrator: CustomerAccountAdministrator,
    private readonly emailSender: EmailSender,
    private readonly recoveryRedirectUrl: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    caseId: string;
    actorAccountId: string;
    traceId: string;
  }): Promise<AccountRecoveryCaseRecord> {
    const existingCase = await this.repository.findCase(input.caseId);
    if (existingCase === null || existingCase.status !== "approved") {
      throw caseNotApprovedError();
    }
    const target = await this.repository.findTargetForRecovery(existingCase.accountId);
    if (target === null) throw caseNotApprovedError();

    const completedAt = this.clock();
    const cooldownEndsAt = new Date(
      completedAt.getTime() + RECOVERY_COOLDOWN_HOURS * 60 * 60 * 1000,
    );

    if (target.isStaff) {
      // Staff target: unchanged -- a staff passkey replacement link.
      try {
        await this.administrator.sendRecoveryCompletionEmail({
          betterAuthUserId: target.betterAuthUserId,
          redirectTo: this.recoveryRedirectUrl,
          traceId: input.traceId,
        });
      } catch (error) {
        throw new AppError({
          code: "authentication.account_recovery_completion_delivery_failed",
          title: "Recovery completion email could not be delivered",
          status: 503,
          detail: "The recovery case remains approved and this operation can be retried safely.",
          cause: error,
        });
      }
    } else {
      await this.endCustomerDeviceAccess({
        caseId: input.caseId,
        accountId: target.accountId,
        betterAuthUserId: target.betterAuthUserId,
        actorAccountId: input.actorAccountId,
        traceId: input.traceId,
        at: completedAt,
      });
    }

    const updated = await this.repository.completeCase({
      caseId: input.caseId,
      actorAccountId: input.actorAccountId,
      traceId: input.traceId,
      completedAt,
      cooldownEndsAt,
    });
    if (updated === null) throw caseNotApprovedError();

    if (target.isStaff) {
      if (target.contactEmail !== null) {
        try {
          await this.emailSender.sendAccountRecoveryCompletedEmail({
            to: target.contactEmail,
            cooldownEndsAt,
          });
        } catch {
          // Best-effort — completion and the cooldown are already durable.
        }
      }
    } else {
      await this.notifyCustomer({
        caseId: input.caseId,
        actorAccountId: input.actorAccountId,
        traceId: input.traceId,
        contactEmail: target.contactEmail,
        cooldownEndsAt,
        at: completedAt,
      });
    }

    return updated;
  }

  /**
   * A customer's recovery ends every way the lost phone could still get in,
   * then lets them back in through Google/Apple sign-in and a fresh device
   * enrolment (E1/E2), the same phone included:
   * 1. their active devices are revoked and their device_key login methods
   *    removed (one transaction, each device audited);
   * 2. every remaining session is ended, device sessions included;
   * 3. recoveryRequiredAt is cleared.
   * The account itself stays in recovery_review until completeCase runs
   * after this, and that status alone refuses sign-in and E2, so clearing the
   * flag first opens no window. Every step is idempotent, so a failure
   * leaves the case approved and completion can simply be retried.
   */
  private async endCustomerDeviceAccess(input: {
    caseId: string;
    accountId: string;
    betterAuthUserId: string;
    actorAccountId: string;
    traceId: string;
    at: Date;
  }): Promise<void> {
    try {
      const devices = await this.repository.revokeDevicesForRecovery({
        caseId: input.caseId,
        accountId: input.accountId,
        actorAccountId: input.actorAccountId,
        traceId: input.traceId,
        revokedAt: input.at,
      });
      const sessions = await this.administrator.revokeSessionsForRecoveryCompletion(
        input.betterAuthUserId,
      );
      await this.repository.recordRecoveryAuditEvent({
        caseId: input.caseId,
        actorAccountId: input.actorAccountId,
        traceId: input.traceId,
        action: "authentication.account_recovery_sessions_revoked",
        changes: {
          account_id: input.accountId,
          revoked_device_count: devices.revokedDeviceIds.length,
          revoked_session_count: sessions.revokedSessionCount,
          revoked_device_session_count: sessions.deviceSessionCount,
        },
        occurredAt: input.at,
      });
      await this.administrator.clearRecoveryRequired(input.betterAuthUserId);
      await this.repository.recordRecoveryAuditEvent({
        caseId: input.caseId,
        actorAccountId: input.actorAccountId,
        traceId: input.traceId,
        action: "authentication.account_recovery_restriction_cleared",
        changes: { account_id: input.accountId },
        occurredAt: input.at,
      });
    } catch (error) {
      throw new AppError({
        code: "authentication.account_recovery_completion_failed",
        title: "Recovery completion could not finish",
        status: 503,
        detail: "The recovery case remains approved and this operation can be retried safely.",
        cause: error,
      });
    }
  }

  /**
   * Best-effort: completion is already durable. The email carries no link;
   * it tells the customer to sign in with Google or Apple and set their
   * phone up again. Whether it went out is audited either way.
   */
  private async notifyCustomer(input: {
    caseId: string;
    actorAccountId: string;
    traceId: string;
    contactEmail: string | null;
    cooldownEndsAt: Date;
    at: Date;
  }): Promise<void> {
    let outcome: "sent" | "failed" | "no_contact_email" = "no_contact_email";
    if (input.contactEmail !== null) {
      try {
        await this.emailSender.sendAccountRecoveryCompletedEmail({
          to: input.contactEmail,
          cooldownEndsAt: input.cooldownEndsAt,
          deviceReenrolmentRequired: true,
        });
        outcome = "sent";
      } catch {
        outcome = "failed";
      }
    }
    try {
      await this.repository.recordRecoveryAuditEvent({
        caseId: input.caseId,
        actorAccountId: input.actorAccountId,
        traceId: input.traceId,
        action: "authentication.account_recovery_reenrolment_notice",
        changes: { outcome },
        occurredAt: input.at,
      });
    } catch {
      // Best-effort, like the notice itself.
    }
  }
}

function targetNotFoundError(): AppError {
  return new AppError({
    code: "authentication.account_recovery_target_not_found",
    title: "Account not found",
    status: 404,
    detail: "No account matches the given account_id.",
  });
}

function targetIsStaffError(): AppError {
  return new AppError({
    code: "authentication.account_recovery_target_is_staff",
    title: "Not a customer account",
    status: 409,
    detail:
      "This account has an active staff role. Use the staff account recovery flow instead.",
  });
}

function targetNotActiveError(): AppError {
  return new AppError({
    code: "authentication.account_recovery_target_not_active",
    title: "Account not eligible for recovery",
    status: 409,
    detail: "The target account is not currently active.",
  });
}

function caseAlreadyOpenError(): AppError {
  return new AppError({
    code: "authentication.account_recovery_case_already_open",
    title: "Recovery case already open",
    status: 409,
    detail: "This account already has an open recovery case.",
  });
}

function caseNotOpenError(): AppError {
  return new AppError({
    code: "authentication.account_recovery_case_not_open",
    title: "Recovery case not open",
    status: 409,
    detail: "This action requires an open recovery case.",
  });
}

function caseNotFoundError(): AppError {
  return new AppError({
    code: "authentication.account_recovery_case_not_found",
    title: "Recovery case not found",
    status: 404,
    detail: "No recovery case matches the given case id.",
  });
}

function primaryReviewUnavailableError(): AppError {
  return new AppError({
    code: "authentication.account_recovery_primary_review_unavailable",
    title: "Primary review unavailable",
    status: 409,
    detail:
      "Recording a primary review requires an open case with a fresh Didit verification on file and no primary review recorded yet.",
  });
}

function sameReviewerError(): AppError {
  return new AppError({
    code: "authentication.account_recovery_same_reviewer",
    title: "A second, different reviewer is required",
    status: 409,
    detail: "The reviewer who recorded the primary review cannot also decide this case.",
  });
}

function decisionUnavailableError(): AppError {
  return new AppError({
    code: "authentication.account_recovery_decision_unavailable",
    title: "Decision unavailable",
    status: 409,
    detail:
      "Deciding this case requires an open case with a primary review already recorded by a different reviewer.",
  });
}

function caseNotApprovedError(): AppError {
  return new AppError({
    code: "authentication.account_recovery_case_not_approved",
    title: "Recovery case not approved",
    status: 409,
    detail: "Completing recovery requires an approved case.",
  });
}

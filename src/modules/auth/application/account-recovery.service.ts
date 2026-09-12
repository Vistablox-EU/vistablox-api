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
    // Phase 4 cutover: completion hands the customer a passkey link, and
    // customer passkeys are refused (PASSKEY_STAFF_ONLY), so the customer
    // could never clear recoveryRequiredAt under a case marked completed.
    // Until Damir decides what completing a customer case does, it's
    // refused and the case stays approved.
    if (!target.isStaff) throw recoveryCompletionUnavailableError();

    const completedAt = this.clock();
    const cooldownEndsAt = new Date(
      completedAt.getTime() + RECOVERY_COOLDOWN_HOURS * 60 * 60 * 1000,
    );

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

    const updated = await this.repository.completeCase({
      caseId: input.caseId,
      actorAccountId: input.actorAccountId,
      traceId: input.traceId,
      completedAt,
      cooldownEndsAt,
    });
    if (updated === null) throw caseNotApprovedError();

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

    return updated;
  }
}

function recoveryCompletionUnavailableError(): AppError {
  return new AppError({
    code: "authentication.account_recovery_completion_unavailable",
    title: "Recovery completion is unavailable",
    status: 409,
    detail:
      "Completing a customer recovery case is unavailable until device-bound recovery completion is decided. The case remains approved.",
  });
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

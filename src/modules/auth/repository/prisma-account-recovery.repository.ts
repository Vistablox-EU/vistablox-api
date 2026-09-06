import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  AccountRecoveryCaseRecord,
  AccountRecoveryCaseStatus,
  AccountRecoveryRepository,
  RecoveryCaseTarget,
  RecoveryCorroborationCategory,
  RecoveryCorroborationFacts,
} from "./account-recovery.repository.js";

export class PrismaAccountRecoveryRepository implements AccountRecoveryRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async findTargetForRecovery(accountId: string): Promise<RecoveryCaseTarget | null> {
    const account = await this.database.account.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        betterAuthUserId: true,
        status: true,
        protectedContactEmail: true,
        staffRoles: { where: { revokedAt: null }, take: 1, select: { id: true } },
      },
    });
    if (account === null) return null;
    return {
      accountId: account.id,
      betterAuthUserId: account.betterAuthUserId,
      status: account.status,
      contactEmail: account.protectedContactEmail,
      isStaff: account.staffRoles.length > 0,
    };
  }

  public async findOpenCaseForAccount(
    accountId: string,
  ): Promise<AccountRecoveryCaseRecord | null> {
    const found = await this.database.accountRecoveryCase.findFirst({
      where: { accountId, status: "open" },
      orderBy: { createdAt: "desc" },
    });
    return found === null ? null : toCaseRecord(found);
  }

  public async findCase(caseId: string): Promise<AccountRecoveryCaseRecord | null> {
    const found = await this.database.accountRecoveryCase.findUnique({
      where: { id: caseId },
    });
    return found === null ? null : toCaseRecord(found);
  }

  public async openCase(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
    openedAt: Date;
  }): Promise<AccountRecoveryCaseRecord> {
    return this.database.$transaction(async (transaction) => {
      const created = await transaction.accountRecoveryCase.create({
        data: {
          id: `recovery_case_${ulid()}`,
          accountId: input.accountId,
          trigger: "full_lockout",
          status: "open",
          createdAt: input.openedAt,
        },
      });
      await transaction.account.update({
        where: { id: input.accountId },
        data: { status: "recovery_review", updatedAt: input.openedAt },
      });
      await transaction.accountRecoveryCode.updateMany({
        where: { accountId: input.accountId, consumedAt: null },
        data: { consumedAt: input.openedAt },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "authentication.account_recovery_case_opened",
          resourceType: "account_recovery_case",
          resourceId: created.id,
          changes: { trace_id: input.traceId, account_id: input.accountId },
          createdAt: input.openedAt,
        },
      });
      return toCaseRecord(created);
    });
  }

  public async recordDiditSession(input: {
    caseId: string;
    diditReference: string;
    actorAccountId: string;
    traceId: string;
    recordedAt: Date;
  }): Promise<AccountRecoveryCaseRecord | null> {
    return this.database.$transaction(async (transaction) => {
      const updated = await transaction.accountRecoveryCase.updateMany({
        where: { id: input.caseId, status: "open" },
        data: { freshDiditVerificationRef: input.diditReference },
      });
      if (updated.count === 0) return null;

      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "authentication.account_recovery_didit_session_created",
          resourceType: "account_recovery_case",
          resourceId: input.caseId,
          changes: { trace_id: input.traceId, didit_reference: input.diditReference },
          createdAt: input.recordedAt,
        },
      });
      const current = await transaction.accountRecoveryCase.findUniqueOrThrow({
        where: { id: input.caseId },
      });
      return toCaseRecord(current);
    });
  }

  public async getCorroborationFacts(accountId: string): Promise<RecoveryCorroborationFacts> {
    const [lastDeposit, lastReservation, lastLogin] = await Promise.all([
      this.database.moneyEvent.findFirst({
        where: { reservation: { accountId } },
        orderBy: { recordedAt: "desc" },
        select: { amountEur: true, recordedAt: true },
      }),
      this.database.reservation.findFirst({
        where: { accountId },
        orderBy: { createdAt: "desc" },
        select: { amountEur: true, createdAt: true },
      }),
      this.database.session.findFirst({
        where: { accountId },
        orderBy: { createdAt: "desc" },
        select: { authMethodAtLogin: true, createdAt: true },
      }),
    ]);

    return {
      lastDeposit:
        lastDeposit === null
          ? null
          : { amountEur: lastDeposit.amountEur.toFixed(2), recordedAt: lastDeposit.recordedAt },
      lastReservation:
        lastReservation === null
          ? null
          : { amountEur: lastReservation.amountEur.toFixed(2), createdAt: lastReservation.createdAt },
      lastLogin:
        lastLogin === null
          ? null
          : { authMethod: lastLogin.authMethodAtLogin, occurredAt: lastLogin.createdAt },
    };
  }

  public async recordPrimaryReview(input: {
    caseId: string;
    reviewerAccountId: string;
    corroborationCategory: RecoveryCorroborationCategory;
    traceId: string;
    reviewedAt: Date;
  }): Promise<AccountRecoveryCaseRecord | null> {
    return this.database.$transaction(async (transaction) => {
      const updated = await transaction.accountRecoveryCase.updateMany({
        where: {
          id: input.caseId,
          status: "open",
          reviewedByPrimary: null,
          freshDiditVerificationRef: { not: null },
        },
        data: { reviewedByPrimary: input.reviewerAccountId },
      });
      if (updated.count === 0) return null;

      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.reviewerAccountId,
          action: "authentication.account_recovery_primary_review_recorded",
          resourceType: "account_recovery_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            corroboration_category: input.corroborationCategory,
          },
          createdAt: input.reviewedAt,
        },
      });
      const current = await transaction.accountRecoveryCase.findUniqueOrThrow({
        where: { id: input.caseId },
      });
      return toCaseRecord(current);
    });
  }

  public async decideCase(input: {
    caseId: string;
    reviewerAccountId: string;
    decision: "approved" | "rejected";
    reason: string;
    traceId: string;
    decidedAt: Date;
  }): Promise<AccountRecoveryCaseRecord | null> {
    return this.database.$transaction(async (transaction) => {
      // Dual control, enforced atomically: a primary review must already be on
      // record, and the deciding reviewer must not be that same reviewer.
      // Rejection deliberately leaves the account in recovery_review — access
      // is not restored that way, and no further restriction is added beyond
      // what opening the case already applied; a human follows up out of band.
      const updated = await transaction.accountRecoveryCase.updateMany({
        where: {
          id: input.caseId,
          status: "open",
          reviewedByPrimary: { not: null },
          NOT: { reviewedByPrimary: input.reviewerAccountId },
        },
        data: {
          status: input.decision,
          reviewedBySecondary: input.reviewerAccountId,
          resolvedAt: input.decidedAt,
        },
      });
      if (updated.count === 0) return null;

      const current = await transaction.accountRecoveryCase.findUniqueOrThrow({
        where: { id: input.caseId },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.reviewerAccountId,
          action: `authentication.account_recovery_case_${input.decision}`,
          resourceType: "account_recovery_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            reason: input.reason,
            primary_reviewer_account_id: current.reviewedByPrimary,
          },
          createdAt: input.decidedAt,
        },
      });
      return toCaseRecord(current);
    });
  }

  public async completeCase(input: {
    caseId: string;
    actorAccountId: string;
    traceId: string;
    completedAt: Date;
    cooldownEndsAt: Date;
  }): Promise<AccountRecoveryCaseRecord | null> {
    return this.database.$transaction(async (transaction) => {
      const updated = await transaction.accountRecoveryCase.updateMany({
        where: { id: input.caseId, status: "approved" },
        data: { status: "completed", cooldownEndsAt: input.cooldownEndsAt },
      });
      if (updated.count === 0) return null;

      const current = await transaction.accountRecoveryCase.findUniqueOrThrow({
        where: { id: input.caseId },
      });
      await transaction.account.update({
        where: { id: current.accountId },
        data: { status: "active", updatedAt: input.completedAt },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "authentication.account_recovery_completed",
          resourceType: "account_recovery_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            cooldown_ends_at: input.cooldownEndsAt.toISOString(),
          },
          createdAt: input.completedAt,
        },
      });
      return toCaseRecord(current);
    });
  }

  public async getActiveCooldown(accountId: string, now: Date): Promise<Date | null> {
    const active = await this.database.accountRecoveryCase.findFirst({
      where: { accountId, status: "completed", cooldownEndsAt: { gt: now } },
      orderBy: { cooldownEndsAt: "desc" },
      select: { cooldownEndsAt: true },
    });
    return active?.cooldownEndsAt ?? null;
  }
}

function toCaseRecord(row: {
  id: string;
  accountId: string;
  status: string;
  freshDiditVerificationRef: string | null;
  reviewedByPrimary: string | null;
  reviewedBySecondary: string | null;
  cooldownEndsAt: Date | null;
  createdAt: Date;
  resolvedAt: Date | null;
}): AccountRecoveryCaseRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    status: asStatus(row.status),
    freshDiditVerificationRef: row.freshDiditVerificationRef,
    reviewedByPrimary: row.reviewedByPrimary,
    reviewedBySecondary: row.reviewedBySecondary,
    cooldownEndsAt: row.cooldownEndsAt,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

function asStatus(status: string): AccountRecoveryCaseStatus {
  if (
    status === "open" ||
    status === "approved" ||
    status === "rejected" ||
    status === "completed"
  ) {
    return status;
  }
  throw new Error(`Unknown account recovery case status: ${status}`);
}

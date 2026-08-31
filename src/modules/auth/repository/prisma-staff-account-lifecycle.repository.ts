import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type { StaffOffboardingReason } from "../application/staff-account-administrator.js";
import type {
  StaffAccountLifecycleRepository,
  StaffAccountLifecycleTarget,
} from "./staff-account-lifecycle.repository.js";

export class PrismaStaffAccountLifecycleRepository
  implements StaffAccountLifecycleRepository
{
  public constructor(private readonly database: DatabaseClient) {}

  public async findTarget(accountId: string): Promise<StaffAccountLifecycleTarget | null> {
    const account = await this.database.account.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        betterAuthUserId: true,
        status: true,
        staffRoles: {
          where: { revokedAt: null },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (account === null) return null;
    return {
      accountId: account.id,
      betterAuthUserId: account.betterAuthUserId,
      status: account.status,
      hasActiveStaffRole: account.staffRoles.length > 0,
    };
  }

  public async prepareRecovery(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
    preparedAt: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const target = await transaction.account.findFirst({
        where: {
          id: input.accountId,
          status: "active",
          staffRoles: { some: { revokedAt: null } },
        },
        select: { id: true },
      });
      if (target === null) return false;

      await transaction.staffSessionMfa.deleteMany({
        where: { accountId: input.accountId },
      });
      await transaction.staffWebAuthnChallenge.deleteMany({
        where: { accountId: input.accountId },
      });
      const credentials = await transaction.staffWebAuthnCredential.deleteMany({
        where: { accountId: input.accountId },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "authentication.staff_account_recovery_started",
          resourceType: "account",
          resourceId: input.accountId,
          changes: {
            trace_id: input.traceId,
            webauthn_credentials_revoked: credentials.count,
            webauthn_reenrollment_required: true,
          },
          createdAt: input.preparedAt,
        },
      });
      return true;
    });
  }

  public async recordRecoveryDeliveryFailure(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
    failedAt: Date;
  }): Promise<void> {
    await this.database.auditLog.create({
      data: {
        id: `audit_${ulid()}`,
        actorAccountId: input.actorAccountId,
        action: "authentication.staff_account_recovery_delivery_failed",
        resourceType: "account",
        resourceId: input.accountId,
        changes: { trace_id: input.traceId },
        createdAt: input.failedAt,
      },
    });
  }

  public async completeOffboarding(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
    reason: StaffOffboardingReason;
    completedAt: Date;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.staffSessionMfa.deleteMany({
        where: { accountId: input.accountId },
      });
      await transaction.staffWebAuthnChallenge.deleteMany({
        where: { accountId: input.accountId },
      });
      const credentials = await transaction.staffWebAuthnCredential.deleteMany({
        where: { accountId: input.accountId },
      });
      const roles = await transaction.staffRoleAssignment.updateMany({
        where: { accountId: input.accountId, revokedAt: null },
        data: { revokedAt: input.completedAt },
      });
      await transaction.account.update({
        where: { id: input.accountId },
        data: { status: "suspended_restricted", updatedAt: input.completedAt },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "authentication.staff_account_offboarded",
          resourceType: "account",
          resourceId: input.accountId,
          changes: {
            trace_id: input.traceId,
            reason: input.reason,
            active_roles_revoked: roles.count,
            webauthn_credentials_revoked: credentials.count,
          },
          createdAt: input.completedAt,
        },
      });
    });
  }
}

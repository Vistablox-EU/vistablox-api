import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type { StaffOffboardingReason } from "../application/staff-account-administrator.js";
import type { StaffRole } from "./staff-invitation.repository.js";
import type {
  StaffAccountLifecycleRepository,
  StaffAccountLifecycleTarget,
  StaffAccountRosterEntry,
  StaffRoleAssignmentRecord,
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

  public async listStaffAccounts(): Promise<StaffAccountRosterEntry[]> {
    const accounts = await this.database.account.findMany({
      where: { staffRoles: { some: {} } },
      select: {
        id: true,
        protectedContactEmail: true,
        status: true,
        staffRoles: {
          orderBy: { grantedAt: "desc" },
          select: {
            id: true,
            role: true,
            legalPracticeId: true,
            appraisalFirmId: true,
            grantedAt: true,
            revokedAt: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return accounts.map((account) => ({
      accountId: account.id,
      email: account.protectedContactEmail,
      status: account.status,
      roles: account.staffRoles.map(toRoleAssignmentRecord),
    }));
  }

  public async hasActiveRole(input: { accountId: string; role: StaffRole }): Promise<boolean> {
    const assignment = await this.database.staffRoleAssignment.findFirst({
      where: { accountId: input.accountId, role: input.role, revokedAt: null },
      select: { id: true },
    });
    return assignment !== null;
  }

  public async grantRole(input: {
    accountId: string;
    role: StaffRole;
    legalPracticeId: string | null;
    appraisalFirmId: string | null;
    actorAccountId: string;
    traceId: string;
    grantedAt: Date;
  }): Promise<StaffRoleAssignmentRecord> {
    return this.database.$transaction(async (transaction) => {
      const assignment = await transaction.staffRoleAssignment.create({
        data: {
          id: `role_${ulid()}`,
          accountId: input.accountId,
          role: input.role,
          legalPracticeId: input.legalPracticeId,
          appraisalFirmId: input.appraisalFirmId,
          grantedAt: input.grantedAt,
        },
        select: {
          id: true,
          role: true,
          legalPracticeId: true,
          appraisalFirmId: true,
          grantedAt: true,
          revokedAt: true,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "authentication.staff_role_granted",
          resourceType: "account",
          resourceId: input.accountId,
          changes: {
            trace_id: input.traceId,
            assignment_id: assignment.id,
            role: input.role,
            legal_practice_id: input.legalPracticeId,
            appraisal_firm_id: input.appraisalFirmId,
          },
          createdAt: input.grantedAt,
        },
      });
      return toRoleAssignmentRecord(assignment);
    });
  }

  public async revokeRole(input: {
    accountId: string;
    assignmentId: string;
    actorAccountId: string;
    traceId: string;
    revokedAt: Date;
  }): Promise<StaffRoleAssignmentRecord | null> {
    return this.database.$transaction(async (transaction) => {
      const updated = await transaction.staffRoleAssignment.updateMany({
        where: { id: input.assignmentId, accountId: input.accountId, revokedAt: null },
        data: { revokedAt: input.revokedAt },
      });
      if (updated.count === 0) return null;

      const assignment = await transaction.staffRoleAssignment.findUniqueOrThrow({
        where: { id: input.assignmentId },
        select: {
          id: true,
          role: true,
          legalPracticeId: true,
          appraisalFirmId: true,
          grantedAt: true,
          revokedAt: true,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "authentication.staff_role_revoked",
          resourceType: "account",
          resourceId: input.accountId,
          changes: {
            trace_id: input.traceId,
            assignment_id: assignment.id,
            role: assignment.role,
          },
          createdAt: input.revokedAt,
        },
      });
      return toRoleAssignmentRecord(assignment);
    });
  }
}

function toRoleAssignmentRecord(assignment: {
  id: string;
  role: string;
  legalPracticeId: string | null;
  appraisalFirmId: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
}): StaffRoleAssignmentRecord {
  return {
    assignmentId: assignment.id,
    role: assignment.role as StaffRole,
    legalPracticeId: assignment.legalPracticeId,
    appraisalFirmId: assignment.appraisalFirmId,
    grantedAt: assignment.grantedAt,
    revokedAt: assignment.revokedAt,
  };
}

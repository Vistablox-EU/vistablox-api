import { AppError } from "../../../shared/errors/app-error.js";
import type {
  StaffAccountLifecycleRepository,
  StaffRoleAssignmentRecord,
} from "../repository/staff-account-lifecycle.repository.js";
import type { StaffRole } from "../repository/staff-invitation.repository.js";
import type {
  StaffAccountAdministrator,
  StaffOffboardingReason,
} from "./staff-account-administrator.js";

export class RecoverStaffAccountService {
  public constructor(
    private readonly repository: StaffAccountLifecycleRepository,
    private readonly administrator: StaffAccountAdministrator,
    private readonly recoveryRedirectUrl: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
  }) {
    rejectSelfAction(input.accountId, input.actorAccountId);
    const target = await this.repository.findTarget(input.accountId);
    if (
      target === null ||
      target.status !== "active" ||
      !target.hasActiveStaffRole
    ) {
      throw unavailableTargetError();
    }

    const preparedAt = this.clock();
    await this.administrator.prepareRecovery({
      betterAuthUserId: target.betterAuthUserId,
      recoveryRequiredAt: preparedAt,
    });
    const prepared = await this.repository.prepareRecovery({
      accountId: target.accountId,
      actorAccountId: input.actorAccountId,
      traceId: input.traceId,
      preparedAt,
    });
    if (!prepared) throw unavailableTargetError();

    try {
      await this.administrator.sendRecoveryEmail({
        betterAuthUserId: target.betterAuthUserId,
        redirectTo: this.recoveryRedirectUrl,
        traceId: input.traceId,
      });
    } catch (error) {
      await this.repository.recordRecoveryDeliveryFailure({
        accountId: target.accountId,
        actorAccountId: input.actorAccountId,
        traceId: input.traceId,
        failedAt: this.clock(),
      });
      throw new AppError({
        code: "authentication.staff_recovery_delivery_failed",
        title: "Staff recovery email could not be delivered",
        status: 503,
        detail:
          "Existing access was revoked, but the recovery email could not be delivered. The operation can be retried safely.",
        cause: error,
      });
    }

    return {
      data: {
        recovery_started: true as const,
        webauthn_reenrollment_required: true as const,
      },
    };
  }
}

export class OffboardStaffAccountService {
  public constructor(
    private readonly repository: StaffAccountLifecycleRepository,
    private readonly administrator: StaffAccountAdministrator,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
    reason: StaffOffboardingReason;
  }) {
    rejectSelfAction(input.accountId, input.actorAccountId);
    const target = await this.repository.findTarget(input.accountId);
    if (target === null) throw unavailableTargetError();

    const completedAt = this.clock();
    await this.administrator.disableAndRevoke({
      betterAuthUserId: target.betterAuthUserId,
      reason: input.reason,
      disabledAt: completedAt,
    });
    await this.repository.completeOffboarding({
      accountId: target.accountId,
      actorAccountId: input.actorAccountId,
      traceId: input.traceId,
      reason: input.reason,
      completedAt,
    });

    return { data: { offboarded: true as const } };
  }
}

export class ListStaffAccountsService {
  public constructor(private readonly repository: StaffAccountLifecycleRepository) {}

  public async execute() {
    const accounts = await this.repository.listStaffAccounts();
    return {
      data: accounts.map((account) => ({
        account_id: account.accountId,
        email: account.email,
        status: account.status,
        roles: account.roles.map(toRoleAssignmentPayload),
      })),
    };
  }
}

export class GrantStaffRoleService {
  public constructor(
    private readonly repository: StaffAccountLifecycleRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
    role: StaffRole;
    legalPracticeId: string | null;
    appraisalFirmId: string | null;
  }) {
    rejectSelfAction(input.accountId, input.actorAccountId);
    const target = await this.repository.findTarget(input.accountId);
    if (target === null || target.status !== "active" || !target.hasActiveStaffRole) {
      throw unavailableTargetError();
    }
    const alreadyGranted = await this.repository.hasActiveRole({
      accountId: input.accountId,
      role: input.role,
    });
    if (alreadyGranted) throw staffRoleAlreadyGrantedError();

    const assignment = await this.repository.grantRole({
      accountId: input.accountId,
      role: input.role,
      legalPracticeId: input.legalPracticeId,
      appraisalFirmId: input.appraisalFirmId,
      actorAccountId: input.actorAccountId,
      traceId: input.traceId,
      grantedAt: this.clock(),
    });

    return { data: toRoleAssignmentPayload(assignment) };
  }
}

export class RevokeStaffRoleService {
  public constructor(
    private readonly repository: StaffAccountLifecycleRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    assignmentId: string;
    actorAccountId: string;
    traceId: string;
  }) {
    rejectSelfAction(input.accountId, input.actorAccountId);
    const revoked = await this.repository.revokeRole({
      accountId: input.accountId,
      assignmentId: input.assignmentId,
      actorAccountId: input.actorAccountId,
      traceId: input.traceId,
      revokedAt: this.clock(),
    });
    if (revoked === null) throw unavailableTargetError();

    return { data: { revoked: true as const } };
  }
}

function toRoleAssignmentPayload(assignment: StaffRoleAssignmentRecord) {
  return {
    assignment_id: assignment.assignmentId,
    role: assignment.role,
    legal_practice_id: assignment.legalPracticeId,
    appraisal_firm_id: assignment.appraisalFirmId,
    granted_at: assignment.grantedAt.toISOString(),
    revoked_at: assignment.revokedAt === null ? null : assignment.revokedAt.toISOString(),
  };
}

function rejectSelfAction(accountId: string, actorAccountId: string): void {
  if (accountId !== actorAccountId) return;
  throw new AppError({
    code: "authentication.staff_account_self_action_forbidden",
    title: "Self-service action unavailable",
    status: 403,
    detail:
      "Staff recovery, offboarding, and role changes must be performed by another administrator.",
  });
}

function unavailableTargetError(): AppError {
  return new AppError({
    code: "authentication.staff_account_target_unavailable",
    title: "Staff account unavailable",
    status: 409,
    detail: "The target account is not eligible for this staff account operation.",
  });
}

function staffRoleAlreadyGrantedError(): AppError {
  return new AppError({
    code: "authentication.staff_role_already_granted",
    title: "Role already granted",
    status: 409,
    detail: "The target account already holds an active assignment of this role.",
  });
}

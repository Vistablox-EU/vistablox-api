import { AppError } from "../../../shared/errors/app-error.js";
import type { StaffAccountLifecycleRepository } from "../repository/staff-account-lifecycle.repository.js";
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

function rejectSelfAction(accountId: string, actorAccountId: string): void {
  if (accountId !== actorAccountId) return;
  throw new AppError({
    code: "authentication.staff_account_self_action_forbidden",
    title: "Self-service action unavailable",
    status: 403,
    detail: "Staff recovery and offboarding must be performed by another administrator.",
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

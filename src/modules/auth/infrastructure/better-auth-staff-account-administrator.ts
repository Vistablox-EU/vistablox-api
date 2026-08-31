import { randomUUID } from "node:crypto";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  StaffAccountAdministrator,
  StaffOffboardingReason,
} from "../application/staff-account-administrator.js";
import type { VistaBloxAuth } from "./better-auth.factory.js";

export class BetterAuthStaffAccountAdministrator implements StaffAccountAdministrator {
  public constructor(private readonly auth: VistaBloxAuth) {}

  public async prepareRecovery(input: {
    betterAuthUserId: string;
    recoveryRequiredAt: Date;
  }): Promise<void> {
    const context = await this.auth.$context;
    const user = await context.internalAdapter.findUserById(input.betterAuthUserId);
    assertActiveStaffUser(user);
    await context.internalAdapter.updateUser(input.betterAuthUserId, {
      recoveryRequiredAt: input.recoveryRequiredAt,
    });
    await context.internalAdapter.deleteUserSessions(input.betterAuthUserId);
  }

  public async sendRecoveryEmail(input: {
    betterAuthUserId: string;
    redirectTo: string;
    traceId: string;
  }): Promise<void> {
    const context = await this.auth.$context;
    const user = await context.internalAdapter.findUserById(input.betterAuthUserId);
    const activeStaffUser = assertActiveStaffUser(user);
    await this.auth.api.requestPasswordReset({
      body: {
        email: activeStaffUser.email,
        redirectTo: input.redirectTo,
      },
      headers: new Headers({
        "x-trace-id": input.traceId,
        "x-vistablox-auth-event-id": `auth_evt_${randomUUID()}`,
      }),
    });
  }

  public async disableAndRevoke(input: {
    betterAuthUserId: string;
    reason: StaffOffboardingReason;
    disabledAt: Date;
  }): Promise<void> {
    const context = await this.auth.$context;
    const user = await context.internalAdapter.findUserById(input.betterAuthUserId);
    const staffUser = assertStaffUser(user);
    if (staffUser.disabledAt == null) {
      await context.internalAdapter.updateUser(input.betterAuthUserId, {
        disabledAt: input.disabledAt,
        disabledReason: input.reason,
      });
    }
    await context.internalAdapter.deleteUserSessions(input.betterAuthUserId);
  }
}

interface StaffAuthUser {
  email: string;
  population: unknown;
  disabledAt: unknown;
}

function assertStaffUser(user: unknown): StaffAuthUser {
  if (
    typeof user !== "object" ||
    user === null ||
    !("email" in user) ||
    typeof (user as Record<string, unknown>).email !== "string" ||
    (user as Record<string, unknown>).population !== "staff_partner"
  ) {
    throw new AppError({
      code: "authentication.staff_account_target_invalid",
      title: "Staff account unavailable",
      status: 409,
      detail: "The target account is not an active staff authentication identity.",
    });
  }
  const record = user as Record<string, unknown>;
  return {
    email: record.email as string,
    population: record.population,
    disabledAt: record.disabledAt,
  };
}

function assertActiveStaffUser(user: unknown): StaffAuthUser {
  const staffUser = assertStaffUser(user);
  if (staffUser.disabledAt != null) {
    throw new AppError({
      code: "authentication.staff_account_disabled",
      title: "Staff account disabled",
      status: 409,
      detail: "A disabled staff account cannot enter account recovery.",
    });
  }
  return staffUser;
}

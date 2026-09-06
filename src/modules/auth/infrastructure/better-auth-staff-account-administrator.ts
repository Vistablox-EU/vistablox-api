import { AppError } from "../../../shared/errors/app-error.js";
import type { EmailSender } from "../../../infrastructure/email/smtp-email-sender.js";
import type {
  StaffAccountAdministrator,
  StaffOffboardingReason,
} from "../application/staff-account-administrator.js";
import type { VistaBloxAuth } from "./better-auth.factory.js";
import { issuePasskeyBootstrap, withPasskeyBootstrapContext } from "./passkey-bootstrap.js";

export class BetterAuthStaffAccountAdministrator implements StaffAccountAdministrator {
  public constructor(
    private readonly auth: VistaBloxAuth,
    private readonly emailSender: EmailSender,
  ) {}

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
    const registrationContext = await issuePasskeyBootstrap({
      auth: this.auth,
      betterAuthUserId: input.betterAuthUserId,
      email: activeStaffUser.email,
      displayName: activeStaffUser.email,
      replaceCredentials: true,
    });
    await this.emailSender.sendPasskeyRecoveryEmail({
      to: activeStaffUser.email,
      recoveryUrl: withPasskeyBootstrapContext(input.redirectTo, registrationContext),
      population: "staff_partner",
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

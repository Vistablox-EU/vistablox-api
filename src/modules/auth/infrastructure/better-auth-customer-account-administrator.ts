import { AppError } from "../../../shared/errors/app-error.js";
import type { EmailSender } from "../../../infrastructure/email/smtp-email-sender.js";
import type { CustomerAccountAdministrator } from "../application/customer-account-administrator.js";
import type { VistaBloxAuth } from "./better-auth.factory.js";
import { issuePasskeyBootstrap, withPasskeyBootstrapContext } from "./passkey-bootstrap.js";

export class BetterAuthCustomerAccountAdministrator implements CustomerAccountAdministrator {
  public constructor(
    private readonly auth: VistaBloxAuth,
    private readonly emailSender: EmailSender,
  ) {}

  public async revokeAllSessions(betterAuthUserId: string): Promise<void> {
    const context = await this.auth.$context;
    const user = await context.internalAdapter.findUserById(betterAuthUserId);
    assertCustomerUser(user);
    await context.internalAdapter.updateUser(betterAuthUserId, {
      recoveryRequiredAt: new Date(),
    });
    await context.internalAdapter.deleteUserSessions(betterAuthUserId);
  }

  public async revokeSessionsForRecoveryCompletion(
    betterAuthUserId: string,
  ): Promise<{ revokedSessionCount: number; deviceSessionCount: number }> {
    const context = await this.auth.$context;
    const user = await context.internalAdapter.findUserById(betterAuthUserId);
    assertCustomerUser(user);
    const sessions = await context.internalAdapter.listSessions(betterAuthUserId);
    const deviceSessionCount = sessions.filter(
      (session) => (session as Record<string, unknown>).authenticationLevel === "device_biometric",
    ).length;
    // Through better-auth's own delete, so every session's delete hooks run:
    // the audit trail and the auth.sessions mirror record each one.
    await context.internalAdapter.deleteUserSessions(betterAuthUserId);
    return { revokedSessionCount: sessions.length, deviceSessionCount };
  }

  public async clearRecoveryRequired(betterAuthUserId: string): Promise<void> {
    const context = await this.auth.$context;
    const user = await context.internalAdapter.findUserById(betterAuthUserId);
    assertCustomerUser(user);
    await context.internalAdapter.updateUser(betterAuthUserId, { recoveryRequiredAt: null });
  }

  public async sendRecoveryCompletionEmail(input: {
    betterAuthUserId: string;
    redirectTo: string;
    traceId: string;
  }): Promise<void> {
    const context = await this.auth.$context;
    const user = await context.internalAdapter.findUserById(input.betterAuthUserId);
    const customerUser = assertCustomerUser(user);
    const registrationContext = await issuePasskeyBootstrap({
      auth: this.auth,
      betterAuthUserId: input.betterAuthUserId,
      email: customerUser.email,
      displayName: customerUser.name,
      replaceCredentials: true,
      customerIdentityVerified: true,
    });
    await this.emailSender.sendPasskeyRecoveryEmail({
      to: customerUser.email,
      recoveryUrl: withPasskeyBootstrapContext(input.redirectTo, registrationContext),
      population: "customer",
    });
  }

  public async prepareSelfServicePasskeyReplacement(
    betterAuthUserId: string,
  ): Promise<string> {
    const context = await this.auth.$context;
    const user = await context.internalAdapter.findUserById(betterAuthUserId);
    const customerUser = assertCustomerUser(user);
    await this.revokeAllSessions(betterAuthUserId);
    return issuePasskeyBootstrap({
      auth: this.auth,
      betterAuthUserId,
      email: customerUser.email,
      displayName: customerUser.name,
      replaceCredentials: true,
      customerIdentityVerified: true,
    });
  }
}

interface CustomerAuthUser {
  email: string;
  name: string;
}

function assertCustomerUser(user: unknown): CustomerAuthUser {
  if (
    typeof user !== "object" ||
    user === null ||
    !("email" in user) ||
    typeof (user as Record<string, unknown>).email !== "string" ||
    (user as Record<string, unknown>).population === "staff_partner"
  ) {
    throw new AppError({
      code: "authentication.customer_account_target_invalid",
      title: "Customer account unavailable",
      status: 409,
      detail: "The target account is not an active customer authentication identity.",
    });
  }
  const record = user as Record<string, unknown>;
  return {
    email: record.email as string,
    name: typeof record.name === "string" && record.name.trim() !== ""
      ? record.name
      : (record.email as string),
  };
}

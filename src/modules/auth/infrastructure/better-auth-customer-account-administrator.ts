import { randomUUID } from "node:crypto";

import { AppError } from "../../../shared/errors/app-error.js";
import type { CustomerAccountAdministrator } from "../application/customer-account-administrator.js";
import type { VistaBloxAuth } from "./better-auth.factory.js";

export class BetterAuthCustomerAccountAdministrator implements CustomerAccountAdministrator {
  public constructor(private readonly auth: VistaBloxAuth) {}

  public async revokeAllSessions(betterAuthUserId: string): Promise<void> {
    const context = await this.auth.$context;
    const user = await context.internalAdapter.findUserById(betterAuthUserId);
    assertCustomerUser(user);
    await context.internalAdapter.deleteUserSessions(betterAuthUserId);
  }

  public async sendRecoveryCompletionEmail(input: {
    betterAuthUserId: string;
    redirectTo: string;
    traceId: string;
  }): Promise<void> {
    const context = await this.auth.$context;
    const user = await context.internalAdapter.findUserById(input.betterAuthUserId);
    const customerUser = assertCustomerUser(user);
    await this.auth.api.requestPasswordReset({
      body: {
        email: customerUser.email,
        redirectTo: input.redirectTo,
      },
      headers: new Headers({
        "x-trace-id": input.traceId,
        "x-vistablox-auth-event-id": `auth_evt_${randomUUID()}`,
      }),
    });
  }
}

interface CustomerAuthUser {
  email: string;
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
  return { email: (user as Record<string, unknown>).email as string };
}

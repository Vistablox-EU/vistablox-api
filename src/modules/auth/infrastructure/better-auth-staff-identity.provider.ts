import { AppError } from "../../../shared/errors/app-error.js";
import type { StaffIdentityProvider } from "../application/staff-identity-provider.js";
import type { VistaBloxAuth } from "./better-auth.factory.js";
import { issuePasskeyBootstrap } from "./passkey-bootstrap.js";

export class BetterAuthStaffIdentityProvider implements StaffIdentityProvider {
  public constructor(private readonly auth: VistaBloxAuth) {}

  public async assertEmailAvailable(email: string): Promise<void> {
    const existing = await this.findUser(email);
    if (existing !== null) throw emailUnavailableError();
  }

  public async createOrResolveInvitedStaff(input: {
    email: string;
    displayName: string;
  }): Promise<{ betterAuthUserId: string; passkeyRegistrationContext: string }> {
    const existing = await this.findUser(input.email);
    if (existing !== null) {
      if (existing.population !== "staff_partner") throw emailUnavailableError();
      return {
        betterAuthUserId: existing.id,
        passkeyRegistrationContext: await issuePasskeyBootstrap({
          auth: this.auth,
          betterAuthUserId: existing.id,
          email: input.email,
          displayName: input.displayName,
          replaceCredentials: false,
        }),
      };
    }

    try {
      const context = await this.auth.$context;
      await context.internalAdapter.createUser({
        name: input.displayName,
        email: input.email,
        emailVerified: true,
        population: "staff_partner",
      }, { method: "internal" });
    } catch (error) {
      throw normalizeBetterAuthCreationError(error);
    }

    const created = await this.findUser(input.email);
    if (created === null || created.population !== "staff_partner") {
      throw new Error("Better Auth did not create the invited staff identity");
    }
    return {
      betterAuthUserId: created.id,
      passkeyRegistrationContext: await issuePasskeyBootstrap({
        auth: this.auth,
        betterAuthUserId: created.id,
        email: input.email,
        displayName: input.displayName,
        replaceCredentials: false,
      }),
    };
  }

  private async findUser(
    email: string,
  ): Promise<{ id: string; population: unknown } | null> {
    const context = await this.auth.$context;
    const result = await context.internalAdapter.findUserByEmail(email);
    if (result === null) return null;
    const user = result.user as typeof result.user & Record<string, unknown>;
    return { id: user.id, population: user.population };
  }
}

function normalizeBetterAuthCreationError(error: unknown): AppError {
  const statusCode = readNumber(error, "statusCode");
  if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
    return new AppError({
      code: "authentication.staff_identity_invalid",
      title: "Staff identity could not be created",
      status: 422,
      detail: "The invited staff identity did not pass authentication policy.",
      cause: error,
    });
  }
  return new AppError({
    code: "authentication.staff_identity_creation_failed",
    title: "Staff identity could not be created",
    status: 503,
    detail: "The authentication service could not create the invited staff identity.",
    cause: error,
  });
}

function emailUnavailableError(): AppError {
  return new AppError({
    code: "authentication.staff_invitation_email_unavailable",
    title: "Email is unavailable",
    status: 409,
    detail: "That email address already belongs to a VistaBlox authentication identity.",
  });
}

function readNumber(input: unknown, key: string): number | null {
  if (typeof input !== "object" || input === null || !(key in input)) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

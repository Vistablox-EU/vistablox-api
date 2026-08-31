import { AppError } from "../../../shared/errors/app-error.js";
import type { StaffIdentityProvider } from "../application/staff-identity-provider.js";
import type { VistaBloxAuth } from "./better-auth.factory.js";

export class BetterAuthStaffIdentityProvider implements StaffIdentityProvider {
  public constructor(private readonly auth: VistaBloxAuth) {}

  public async assertEmailAvailable(email: string): Promise<void> {
    const existing = await this.findUser(email);
    if (existing !== null) throw emailUnavailableError();
  }

  public async createOrResolveInvitedStaff(input: {
    email: string;
    displayName: string;
    password: string;
  }): Promise<{ betterAuthUserId: string }> {
    const existing = await this.findUser(input.email);
    if (existing !== null) {
      if (existing.population !== "staff_partner") throw emailUnavailableError();
      return { betterAuthUserId: existing.id };
    }

    try {
      await this.auth.api.signUpEmail({
        body: {
          name: input.displayName,
          email: input.email,
          password: input.password,
          population: "staff_partner",
        },
      });
    } catch (error) {
      throw normalizeBetterAuthCreationError(error);
    }

    const created = await this.findUser(input.email);
    if (created === null || created.population !== "staff_partner") {
      throw new Error("Better Auth did not create the invited staff identity");
    }
    const context = await this.auth.$context;
    await context.internalAdapter.updateUser(created.id, { emailVerified: true });
    return { betterAuthUserId: created.id };
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
  const code = readNestedString(error, "body", "code");
  if (code === "PASSWORD_COMPROMISED") {
    return new AppError({
      code: "authentication.password_compromised",
      title: "Password is compromised",
      status: 422,
      detail: "Choose a password that has not appeared in a known breach.",
      cause: error,
    });
  }
  const statusCode = readNumber(error, "statusCode");
  if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
    return new AppError({
      code: "authentication.staff_identity_invalid",
      title: "Staff identity could not be created",
      status: 422,
      detail: "The supplied staff credentials did not pass authentication policy.",
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

function readNestedString(input: unknown, key: string, nestedKey: string): string | null {
  if (typeof input !== "object" || input === null || !(key in input)) return null;
  const nested = (input as Record<string, unknown>)[key];
  if (typeof nested !== "object" || nested === null || !(nestedKey in nested)) return null;
  const value = (nested as Record<string, unknown>)[nestedKey];
  return typeof value === "string" ? value : null;
}

function readNumber(input: unknown, key: string): number | null {
  if (typeof input !== "object" || input === null || !(key in input)) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

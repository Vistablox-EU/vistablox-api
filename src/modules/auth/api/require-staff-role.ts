import type { RequestHandler } from "express";

import type { AccountRepository } from "../../account/repository/account.repository.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { StaffMfaSessionVerifier } from "../application/staff-mfa-session-verifier.js";

export function createRequireAdminOperations(
  accounts: AccountRepository,
): RequestHandler {
  return async (_request, response, next) => {
    try {
      const authContext = response.locals.authContext;
      if (authContext === undefined) {
        throw new AppError({
          code: "authentication.context_missing",
          title: "Authentication unavailable",
          status: 500,
          detail: "The authenticated account context is unavailable.",
        });
      }

      const authorized =
        authContext.population === "staff_partner" &&
        (await accounts.hasActiveStaffRole(authContext.accountId, "admin_operations"));
      if (!authorized) {
        throw new AppError({
          code: "authorization.forbidden",
          title: "Action not permitted",
          status: 403,
          detail: "The admin operations role is required for this action.",
        });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function createRequireStaffIdentity(accounts: AccountRepository): RequestHandler {
  return async (_request, response, next) => {
    try {
      const authContext = response.locals.authContext;
      if (authContext === undefined) {
        throw missingContextError();
      }
      const authorized =
        authContext.population === "staff_partner" &&
        (await accounts.hasAnyActiveStaffRole(authContext.accountId));
      if (!authorized) throw staffForbiddenError();
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function createRequireStaffWebAuthn(
  verifier: StaffMfaSessionVerifier,
): RequestHandler {
  return async (_request, response, next) => {
    try {
      const authContext = response.locals.authContext;
      if (authContext === undefined) throw missingContextError();
      const verified = await verifier.isSessionVerified(
        authContext.accountId,
        authContext.providerSessionId,
      );
      if (!verified) {
        throw new AppError({
          code: "authentication.staff_mfa_required",
          title: "Staff MFA required",
          status: 403,
          detail: "Complete WebAuthn verification for this staff session.",
        });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

function missingContextError(): AppError {
  return new AppError({
    code: "authentication.context_missing",
    title: "Authentication unavailable",
    status: 500,
    detail: "The authenticated account context is unavailable.",
  });
}

function staffForbiddenError(): AppError {
  return new AppError({
    code: "authorization.forbidden",
    title: "Action not permitted",
    status: 403,
    detail: "An active staff or partner role is required for this action.",
  });
}

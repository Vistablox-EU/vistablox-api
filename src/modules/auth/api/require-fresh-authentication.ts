import type { RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { CustomerSessionRepository } from "../repository/customer-session.repository.js";

const FRESH_AUTH_WINDOW_MS = 15 * 60 * 1000;

export function createRequireFreshAuthentication(
  sessions: CustomerSessionRepository,
  clock: () => Date = () => new Date(),
): RequestHandler {
  return async (_request, response, next) => {
    try {
      const context = response.locals.authContext;
      if (context === undefined) throw freshAuthRequired();
      const verified = await sessions.hasFreshAuthentication?.({
        accountId: context.accountId,
        providerSessionId: context.providerSessionId,
        freshAfter: new Date(clock().getTime() - FRESH_AUTH_WINDOW_MS),
      });
      if (verified !== true) throw freshAuthRequired();
      next();
    } catch (error) {
      next(error);
    }
  };
}

function freshAuthRequired(): AppError {
  return new AppError({
    code: "authentication.fresh_auth_required",
    title: "Fresh authentication required",
    status: 403,
    detail: "Confirm with a passkey or authenticator code before continuing.",
  });
}

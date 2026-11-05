import type { RequestHandler } from "express";

import { AppError } from "../../../../shared/errors/app-error.js";
import { FRESH_AUTH_WINDOW_MS, isFreshDeviceSession } from "../../domain/fresh-authentication.js";
import type { CustomerSessionRepository } from "../../repository/customer/customer-session.repository.js";

export function createRequireFreshAuthentication(
  sessions: CustomerSessionRepository,
  clock: () => Date = () => new Date(),
): RequestHandler {
  return async (_request, response, next) => {
    try {
      const context = response.locals.authContext;
      if (context === undefined) throw freshAuthRequired();
      const now = clock();
      if (isFreshDeviceSession(context, now)) {
        next();
        return;
      }
      const verified = await sessions.hasFreshAuthentication?.({
        accountId: context.accountId,
        providerSessionId: context.providerSessionId,
        freshAfter: new Date(now.getTime() - FRESH_AUTH_WINDOW_MS),
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
    detail: "Sign in again on this device before continuing.",
  });
}

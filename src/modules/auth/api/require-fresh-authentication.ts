import type { RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { CustomerSessionRepository } from "../repository/customer-session.repository.js";

const FRESH_AUTH_WINDOW_MS = 5 * 60 * 1000;

export function createRequireFreshAuthentication(
  sessions: CustomerSessionRepository,
  clock: () => Date = () => new Date(),
): RequestHandler {
  return async (_request, response, next) => {
    try {
      const context = response.locals.authContext;
      if (context === undefined) throw freshAuthRequired();
      // Interim rule (device-bound cutover): a customer device-biometric
      // session is always fresh. Every request already carries a DPoP proof
      // signed by the biometric-protected hardware key, which is strictly
      // stronger than the old 5-minute time-based window over a TOTP code.
      // That window made these routes permanently dead for long-lived device
      // sessions: no customer factor sets lastFreshAuthAt any more.
      if (
        context.population === "customer" &&
        context.authenticationLevel === "device_biometric"
      ) {
        next();
        return;
      }
      const freshAfter = new Date(clock().getTime() - FRESH_AUTH_WINDOW_MS);
      const verified = await sessions.hasFreshAuthentication?.({
        accountId: context.accountId,
        providerSessionId: context.providerSessionId,
        freshAfter,
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

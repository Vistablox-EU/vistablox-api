import type { RequestHandler } from "express";

import type { AccountRepository } from "../../account/repository/account.repository.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { SessionResolver } from "../application/session-resolver.js";

export function createRequireAuthentication(
  sessions: SessionResolver,
  accounts: AccountRepository,
): RequestHandler {
  return async (request, response, next) => {
    try {
      const identity = await sessions.resolve(request.headers);
      if (identity === null) {
        throw new AppError({
          code: "authentication.required",
          title: "Authentication required",
          status: 401,
          detail: "A valid authenticated session is required.",
        });
      }

      const account = await accounts.findByBetterAuthUserId(identity.betterAuthUserId);
      if (account === null) {
        throw new AppError({
          code: "account.mapping_missing",
          title: "Account unavailable",
          status: 500,
          detail: "The authenticated identity is not linked to a VistaBlox account.",
        });
      }
      if (account.status !== "active") {
        throw new AppError({
          code: "account.restricted",
          title: "Account restricted",
          status: 403,
          detail: "This account is currently restricted from product actions.",
        });
      }

      response.locals.authContext = {
        accountId: account.accountId,
        providerSessionId: identity.providerSessionId,
        population: identity.population,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
}

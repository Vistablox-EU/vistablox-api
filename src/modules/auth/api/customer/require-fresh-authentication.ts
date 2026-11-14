import type { RequestHandler } from "express";

import { freshAuthenticationRequiredError } from "../../../../shared/errors/fresh-authentication-required-error.js";
import { FRESH_AUTH_WINDOW_MS, isFreshDeviceSession } from "../../domain/fresh-authentication.js";
import type { CustomerSessionRepository } from "../../repository/customer/customer-session.repository.js";
import type { AuthContext } from "../shared/auth-context.js";

/**
 * A non-throwing question about the caller's session: has it confirmed who is
 * holding it recently enough? It is for routes that need freshness only on
 * some of their paths (and so cannot mount the middleware): the router asks
 * with the server-set auth context and hands the answer on as a boolean. It
 * never reads a request field the client controls. A missing context is
 * false. A repository that cannot answer is false; a repository that fails
 * rejects, and the caller must not treat that as fresh.
 */
export type FreshAuthenticationProbe = (context: AuthContext | undefined) => Promise<boolean>;

export function createFreshAuthenticationProbe(
  sessions: CustomerSessionRepository,
  clock: () => Date = () => new Date(),
): FreshAuthenticationProbe {
  return async (context) => {
    if (context === undefined) return false;
    const now = clock();
    if (isFreshDeviceSession(context, now)) return true;
    const verified = await sessions.hasFreshAuthentication?.({
      accountId: context.accountId,
      providerSessionId: context.providerSessionId,
      freshAfter: new Date(now.getTime() - FRESH_AUTH_WINDOW_MS),
    });
    return verified === true;
  };
}

export function createRequireFreshAuthentication(
  sessions: CustomerSessionRepository,
  clock: () => Date = () => new Date(),
): RequestHandler {
  const isFresh = createFreshAuthenticationProbe(sessions, clock);
  return async (_request, response, next) => {
    try {
      if (!(await isFresh(response.locals.authContext))) throw freshAuthenticationRequiredError();
      next();
    } catch (error) {
      next(error);
    }
  };
}

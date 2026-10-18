import type { RequestHandler } from "express";

import { AppError } from "../../../../shared/errors/app-error.js";
import { isAuthPathAllowed } from "../../domain/disabled-auth-routes.js";

/**
 * Keeps disabled credential/email-code endpoints and open passkey deletion
 * off the public wire.
 *
 * Judges `request.url`, the request-target string that better-call's node
 * adapter appends to its base URL when it builds the request Better Auth
 * routes (this handler is mounted at the app level, so it is the full request
 * target as received), never Express's `request.path` and never a decoded
 * copy. Better Auth routes on the URL-standard normalisation of that string,
 * which differs from the string itself whenever it holds dot segments (also
 * percent-encoded), backslashes and so on. So a path is only matched against
 * the disabled list once it is known to be its own normalisation
 * (isCanonicalAuthPath); any other path is refused, whether or not Better Auth
 * would have served it, rather than guessed at. Were it
 * mounted under a prefix (app.use("/api/auth", ...)), Express would strip the
 * prefix from `request.url` and every request would be refused, so a changed
 * mount fails closed.
 *
 * This is the first of two layers. The second runs inside Better Auth
 * (createBetterAuthDisabledRoutesPlugin) on the pathname its router is about
 * to use, so it holds even for a request this layer saw differently.
 */
export const rejectDisabledAuthRoutes: RequestHandler = (request, _response, next) => {
  if (!isAuthPathAllowed(pathOf(request.url))) {
    next(
      new AppError({
        code: "resource.not_found",
        title: "Resource not found",
        status: 404,
        detail: "The requested resource does not exist.",
      }),
    );
    return;
  }
  next();
};

/** A request target up to its query string or fragment, where URL parsing ends the path. */
function pathOf(target: string): string {
  const end = target.search(/[?#]/);
  return end === -1 ? target : target.slice(0, end);
}

import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { UnlinkLoginMethodService } from "../application/unlink-login-method.service.js";
import { unlinkLoginMethodParamsSchema } from "./login-methods.schemas.js";

export function createLoginMethodsRouter(
  requireAuthentication: RequestHandler,
  unlinkLoginMethod: UnlinkLoginMethodService,
): Router {
  const router = Router();
  router.post(
    "/:method_type/unlink",
    requireAuthentication,
    async (request, response) => {
      requireAuthContext(response.locals.authContext);
      const params = unlinkLoginMethodParamsSchema.parse(request.params);
      await unlinkLoginMethod.execute(params.method_type, request.headers);
      response.status(204).end();
    },
  );
  return router;
}

function requireAuthContext(context: Express.Locals["authContext"]): void {
  if (context === undefined) {
    throw new AppError({
      code: "authentication.context_missing",
      title: "Authentication unavailable",
      status: 500,
      detail: "The authenticated account context is unavailable.",
    });
  }
}

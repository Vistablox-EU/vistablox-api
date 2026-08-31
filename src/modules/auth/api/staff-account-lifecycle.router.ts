import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import {
  OffboardStaffAccountService,
  RecoverStaffAccountService,
} from "../application/staff-account-lifecycle.service.js";
import {
  offboardStaffAccountBodySchema,
  offboardStaffAccountResponseSchema,
  recoverStaffAccountBodySchema,
  recoverStaffAccountResponseSchema,
  staffAccountLifecycleParamsSchema,
} from "./staff-account-lifecycle.schemas.js";

export function createStaffAccountLifecycleRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  recoverStaffAccount: RecoverStaffAccountService,
  offboardStaffAccount: OffboardStaffAccountService,
): Router {
  const router = Router();
  const authorization = [
    requireAuthentication,
    requireAdminOperations,
    requireStaffWebAuthn,
  ];

  router.post("/:account_id/recovery", ...authorization, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) throw missingContextError();
    const params = staffAccountLifecycleParamsSchema.parse(request.params);
    recoverStaffAccountBodySchema.parse(request.body ?? {});
    const result = await recoverStaffAccount.execute({
      accountId: params.account_id,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
    });
    response.status(202).json(recoverStaffAccountResponseSchema.parse(result));
  });

  router.post("/:account_id/offboard", ...authorization, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) throw missingContextError();
    const params = staffAccountLifecycleParamsSchema.parse(request.params);
    const body = offboardStaffAccountBodySchema.parse(request.body);
    const result = await offboardStaffAccount.execute({
      accountId: params.account_id,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
      reason: body.reason,
    });
    response.json(offboardStaffAccountResponseSchema.parse(result));
  });

  return router;
}

function missingContextError(): AppError {
  return new AppError({
    code: "authentication.context_missing",
    title: "Authentication unavailable",
    status: 500,
    detail: "The authenticated account context is unavailable.",
  });
}

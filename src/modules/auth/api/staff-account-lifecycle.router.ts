import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import {
  GrantStaffRoleService,
  ListStaffAccountsService,
  OffboardStaffAccountService,
  RecoverStaffAccountService,
  RevokeStaffRoleService,
} from "../application/staff-account-lifecycle.service.js";
import {
  grantStaffRoleBodySchema,
  grantStaffRoleResponseSchema,
  listStaffAccountsResponseSchema,
  offboardStaffAccountBodySchema,
  offboardStaffAccountResponseSchema,
  recoverStaffAccountBodySchema,
  recoverStaffAccountResponseSchema,
  revokeStaffRoleResponseSchema,
  staffAccountLifecycleParamsSchema,
  staffRoleAssignmentParamsSchema,
} from "./staff-account-lifecycle.schemas.js";

export function createStaffAccountLifecycleRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  recoverStaffAccount: RecoverStaffAccountService,
  offboardStaffAccount: OffboardStaffAccountService,
  listStaffAccounts: ListStaffAccountsService,
  grantStaffRole: GrantStaffRoleService,
  revokeStaffRole: RevokeStaffRoleService,
): Router {
  const router = Router();
  const authorization = [
    requireAuthentication,
    requireAdminOperations,
    requireStaffWebAuthn,
  ];

  router.get("/", ...authorization, async (_request, response) => {
    const result = await listStaffAccounts.execute();
    response.setHeader("Cache-Control", "no-store");
    response.json(listStaffAccountsResponseSchema.parse(result));
  });

  router.post("/:account_id/roles", ...authorization, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) throw missingContextError();
    const params = staffAccountLifecycleParamsSchema.parse(request.params);
    const body = grantStaffRoleBodySchema.parse(request.body);
    const result = await grantStaffRole.execute({
      accountId: params.account_id,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
      role: body.role,
      legalPracticeId: body.legal_practice_id,
      appraisalFirmId: body.appraisal_firm_id,
    });
    response.status(201).json(grantStaffRoleResponseSchema.parse(result));
  });

  router.post(
    "/:account_id/roles/:assignment_id/revoke",
    ...authorization,
    async (request, response) => {
      const authContext = response.locals.authContext;
      if (authContext === undefined) throw missingContextError();
      const params = staffRoleAssignmentParamsSchema.parse(request.params);
      const result = await revokeStaffRole.execute({
        accountId: params.account_id,
        assignmentId: params.assignment_id,
        actorAccountId: authContext.accountId,
        traceId: String(response.locals.traceId),
      });
      response.json(revokeStaffRoleResponseSchema.parse(result));
    },
  );

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

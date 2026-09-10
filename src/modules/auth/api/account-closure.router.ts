import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  CancelAccountClosureService,
  RequestAccountClosureService,
} from "../application/account-closure.service.js";
import type { AccountClosureRequestRecord } from "../repository/account-closure.repository.js";
import {
  accountClosureRequestResponseSchema,
  requestAccountClosureBodySchema,
} from "./account-closure.schemas.js";

export function createAccountClosureRouter(
  requireAuthentication: RequestHandler,
  requestClosure: RequestAccountClosureService,
  cancelClosure: CancelAccountClosureService,
): Router {
  const router = Router();

  router.post("/", requireAuthentication, async (request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const body = requestAccountClosureBodySchema.parse(request.body ?? {});
    const result = await requestClosure.execute({
      accountId: context.accountId,
      reason: body.reason ?? null,
    });
    response.status(201).json(accountClosureRequestResponseSchema.parse({ data: toPayload(result) }));
  });

  router.post("/cancel", requireAuthentication, async (_request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const result = await cancelClosure.execute(context.accountId);
    response.json(accountClosureRequestResponseSchema.parse({ data: toPayload(result) }));
  });

  return router;
}

function toPayload(record: AccountClosureRequestRecord) {
  return {
    closure_request_id: record.id,
    account_id: record.accountId,
    status: record.status,
    reason: record.reason,
    requested_at: record.requestedAt.toISOString(),
    resolved_at: record.resolvedAt?.toISOString() ?? null,
    resolved_by: record.resolvedBy,
    resolution_note: record.resolutionNote,
  };
}

function requireCustomerContext(
  context: Express.Locals["authContext"],
): { accountId: string } {
  if (context === undefined) {
    throw new AppError({
      code: "authentication.context_missing",
      title: "Authentication unavailable",
      status: 500,
      detail: "The authenticated account context is unavailable.",
    });
  }
  if (context.population !== "customer") {
    throw new AppError({
      code: "authorization.forbidden",
      title: "Action not permitted",
      status: 403,
      detail: "Account closure requests are available only to customer accounts.",
    });
  }
  return { accountId: context.accountId };
}

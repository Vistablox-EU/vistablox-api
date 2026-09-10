import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  DecideAccountClosureRequestService,
  ListPendingAccountClosureRequestsService,
} from "../application/account-closure.service.js";
import type { AccountClosureRequestRecord } from "../repository/account-closure.repository.js";
import {
  accountClosureRequestParamsSchema,
  accountClosureRequestResponseSchema,
  decideAccountClosureRequestBodySchema,
  listPendingAccountClosureRequestsResponseSchema,
} from "./account-closure.schemas.js";

export function createAccountClosureOperationsRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  listPending: ListPendingAccountClosureRequestsService,
  decideRequest: DecideAccountClosureRequestService,
): Router {
  const router = Router();
  const authorization = [requireAuthentication, requireAdminOperations, requireStaffWebAuthn];

  router.get("/", ...authorization, async (_request, response) => {
    const result = await listPending.execute();
    response.setHeader("Cache-Control", "no-store");
    response.json(
      listPendingAccountClosureRequestsResponseSchema.parse({ data: result.map(toPayload) }),
    );
  });

  router.post("/:request_id/decision", ...authorization, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) throw missingContextError();
    const params = accountClosureRequestParamsSchema.parse(request.params);
    const body = decideAccountClosureRequestBodySchema.parse(request.body);
    const result = await decideRequest.execute({
      requestId: params.request_id,
      reviewerAccountId: authContext.accountId,
      decision: body.decision,
      note: body.note ?? null,
    });
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

function missingContextError(): AppError {
  return new AppError({
    code: "authentication.context_missing",
    title: "Authentication unavailable",
    status: 500,
    detail: "The authenticated account context is unavailable.",
  });
}

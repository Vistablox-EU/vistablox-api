import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import {
  GetCaseForOperationsService,
  ListCasesForOperationsService,
  PublishInformationRequestService,
  RecordFounderDecisionService,
} from "../application/operations-case.service.js";
import { caseIdParamsSchema } from "./origination.schemas.js";
import {
  founderDecisionBodySchema,
  founderDecisionResponseSchema,
  operationsCaseDetailResponseSchema,
  operationsCaseListQuerySchema,
  operationsCaseListResponseSchema,
  publishInformationRequestBodySchema,
  publishInformationRequestResponseSchema,
} from "./origination-operations.schemas.js";

export function createOriginationOperationsRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  listCases: ListCasesForOperationsService,
  getCase: GetCaseForOperationsService,
  publishInformationRequest: PublishInformationRequestService,
  recordDecision: RecordFounderDecisionService,
): Router {
  const router = Router();
  const staffOnly = [requireAuthentication, requireAdminOperations, requireStaffWebAuthn];

  router.get("/", ...staffOnly, async (request, response) => {
    const query = operationsCaseListQuerySchema.parse(request.query);
    const result = await listCases.execute({ query });
    response.json(operationsCaseListResponseSchema.parse(result));
  });

  router.get("/:case_id", ...staffOnly, async (request, response) => {
    const params = caseIdParamsSchema.parse(request.params);
    const result = await getCase.execute(params.case_id);
    response.json(operationsCaseDetailResponseSchema.parse({ data: result }));
  });

  router.post("/:case_id/information-requests", ...staffOnly, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const body = publishInformationRequestBodySchema.parse(request.body);
    const result = await publishInformationRequest.execute({
      accountId: authContext.accountId,
      caseId: params.case_id,
      traceId: String(response.locals.traceId),
      body,
    });
    response.status(201).json(publishInformationRequestResponseSchema.parse(result));
  });

  router.post("/:case_id/decisions", ...staffOnly, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const body = founderDecisionBodySchema.parse(request.body);
    const result = await recordDecision.execute({
      accountId: authContext.accountId,
      caseId: params.case_id,
      traceId: String(response.locals.traceId),
      body,
    });
    response.json(founderDecisionResponseSchema.parse(result));
  });

  return router;
}

function requireAuthContext(authContext: Express.Locals["authContext"]) {
  if (authContext === undefined) {
    throw new AppError({
      code: "authentication.context_missing",
      title: "Authentication unavailable",
      status: 500,
      detail: "The authenticated account context is unavailable.",
    });
  }
  return authContext;
}

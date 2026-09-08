import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import {
  AssignPartnerOrganizationService,
  CloseCaseService,
  GetCaseForOperationsService,
  ListCasesForOperationsService,
  PublishInformationRequestService,
  RecordFounderDecisionService,
} from "../application/operations-case.service.js";
import {
  ListCaseMessagesForOperationsService,
  PostCaseMessageForOperationsService,
} from "../application/case-message.service.js";
import { caseIdParamsSchema, listCaseMessagesResponseSchema, postCaseMessageResponseSchema } from "./origination.schemas.js";
import {
  assignPartnerOrganizationBodySchema,
  assignPartnerOrganizationResponseSchema,
  closeCaseBodySchema,
  closeCaseResponseSchema,
  founderDecisionBodySchema,
  founderDecisionResponseSchema,
  listCaseMessagesQuerySchema,
  operationsCaseDetailResponseSchema,
  operationsCaseListQuerySchema,
  operationsCaseListResponseSchema,
  postOperationsCaseMessageBodySchema,
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
  closeCase: CloseCaseService,
  listCaseMessages: ListCaseMessagesForOperationsService,
  postCaseMessage: PostCaseMessageForOperationsService,
  // Optional: only present once the partner-organizations feature
  // (protectedApi.partnerOrganizations) is configured, unlike everything
  // else on this router, which is unconditional. See app.ts.
  assignPartnerOrganization?: AssignPartnerOrganizationService,
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

  router.post("/:case_id/close", ...staffOnly, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const body = closeCaseBodySchema.parse(request.body);
    const result = await closeCase.execute({
      accountId: authContext.accountId,
      caseId: params.case_id,
      traceId: String(response.locals.traceId),
      body,
    });
    response.json(closeCaseResponseSchema.parse(result));
  });

  if (assignPartnerOrganization !== undefined) {
    router.post("/:case_id/partner-assignment", ...staffOnly, async (request, response) => {
      const authContext = requireAuthContext(response.locals.authContext);
      const params = caseIdParamsSchema.parse(request.params);
      const body = assignPartnerOrganizationBodySchema.parse(request.body);
      const result = await assignPartnerOrganization.execute({
        caseId: params.case_id,
        actorAccountId: authContext.accountId,
        traceId: String(response.locals.traceId),
        body,
      });
      response.json(assignPartnerOrganizationResponseSchema.parse(result));
    });
  }

  router.get("/:case_id/messages", ...staffOnly, async (request, response) => {
    const params = caseIdParamsSchema.parse(request.params);
    const query = listCaseMessagesQuerySchema.parse(request.query);
    const result = await listCaseMessages.execute(params.case_id, query.lane);
    response.json(listCaseMessagesResponseSchema.parse(result));
  });

  router.post("/:case_id/messages", ...staffOnly, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const body = postOperationsCaseMessageBodySchema.parse(request.body);
    const result = await postCaseMessage.execute({
      accountId: authContext.accountId,
      caseId: params.case_id,
      lane: body.lane,
      body: body.body,
    });
    response.status(201).json(postCaseMessageResponseSchema.parse(result));
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

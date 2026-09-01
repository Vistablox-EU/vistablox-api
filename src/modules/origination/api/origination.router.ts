import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import { CreateDraftIntakeService } from "../application/create-draft-intake.service.js";
import { GetOwnCaseService, ListOwnCasesService } from "../application/read-own-cases.service.js";
import { SubmitInitialCaseService } from "../application/submit-initial-case.service.js";
import {
  ListOwnInformationRequestsService,
  RespondToInformationRequestService,
} from "../application/respond-to-information-request.service.js";
import {
  ListOwnCaseMessagesService,
  PostOwnCaseMessageService,
} from "../application/case-message.service.js";
import {
  caseIdParamsSchema,
  createDraftIntakeBodySchema,
  createDraftIntakeResponseSchema,
  getOwnCaseResponseSchema,
  informationRequestParamsSchema,
  listCaseMessagesResponseSchema,
  listInformationRequestsResponseSchema,
  listOwnCasesQuerySchema,
  listOwnCasesResponseSchema,
  postCaseMessageBodySchema,
  postCaseMessageResponseSchema,
  submitInitialCaseBodySchema,
  submitInitialCaseResponseSchema,
  resubmitCaseResponseSchema,
} from "./origination.schemas.js";

export function createOriginationRouter(
  requireAuthentication: RequestHandler,
  createDraftIntake: CreateDraftIntakeService,
  listOwnCases: ListOwnCasesService,
  getOwnCase: GetOwnCaseService,
  submitInitialCase: SubmitInitialCaseService,
  listInformationRequests: ListOwnInformationRequestsService,
  respondToInformationRequest: RespondToInformationRequestService,
  listOwnCaseMessages: ListOwnCaseMessagesService,
  postOwnCaseMessage: PostOwnCaseMessageService,
): Router {
  const router = Router();

  router.post("/", requireAuthentication, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const body = createDraftIntakeBodySchema.parse(request.body);
    const result = await createDraftIntake.execute({
      accountId: authContext.accountId,
      traceId: String(response.locals.traceId),
      body,
    });
    response.status(201).json(createDraftIntakeResponseSchema.parse(result));
  });

  router.get("/", requireAuthentication, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const query = listOwnCasesQuerySchema.parse(request.query);
    const result = await listOwnCases.execute({ accountId: authContext.accountId, query });
    response.json(listOwnCasesResponseSchema.parse(result));
  });

  router.get("/:case_id", requireAuthentication, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const originationCase = await getOwnCase.execute(authContext.accountId, params.case_id);
    response.json(getOwnCaseResponseSchema.parse({ data: originationCase }));
  });

  router.post("/:case_id/submit", requireAuthentication, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const body = submitInitialCaseBodySchema.parse(request.body);
    const result = await submitInitialCase.execute({
      accountId: authContext.accountId,
      caseId: params.case_id,
      traceId: String(response.locals.traceId),
      body,
    });
    response.status(200).json(submitInitialCaseResponseSchema.parse(result));
  });

  router.get("/:case_id/information-requests", requireAuthentication, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const result = await listInformationRequests.execute(authContext.accountId, params.case_id);
    response.json(listInformationRequestsResponseSchema.parse(result));
  });

  router.post(
    "/:case_id/information-requests/:request_id/respond",
    requireAuthentication,
    async (request, response) => {
      const authContext = requireAuthContext(response.locals.authContext);
      const params = informationRequestParamsSchema.parse(request.params);
      const body = submitInitialCaseBodySchema.parse(request.body);
      const result = await respondToInformationRequest.execute({
        accountId: authContext.accountId,
        caseId: params.case_id,
        requestId: params.request_id,
        traceId: String(response.locals.traceId),
        body,
      });
      response.status(201).json(resubmitCaseResponseSchema.parse(result));
    },
  );

  router.get("/:case_id/messages", requireAuthentication, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const result = await listOwnCaseMessages.execute(authContext.accountId, params.case_id);
    response.json(listCaseMessagesResponseSchema.parse(result));
  });

  router.post("/:case_id/messages", requireAuthentication, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const body = postCaseMessageBodySchema.parse(request.body);
    const result = await postOwnCaseMessage.execute({
      accountId: authContext.accountId,
      caseId: params.case_id,
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

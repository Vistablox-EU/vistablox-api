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
} from "./intake.schemas.js";
import { sendValidated } from "../../../shared/http/send-validated.js";

export function createIntakeRouter(
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
    sendValidated(response, createDraftIntakeResponseSchema, result, 201);
  });

  router.get("/", requireAuthentication, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const query = listOwnCasesQuerySchema.parse(request.query);
    const result = await listOwnCases.execute({ accountId: authContext.accountId, query });
    sendValidated(response, listOwnCasesResponseSchema, result);
  });

  router.get("/:case_id", requireAuthentication, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const intakeCase = await getOwnCase.execute(authContext.accountId, params.case_id);
    sendValidated(response, getOwnCaseResponseSchema, { data: intakeCase });
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
    sendValidated(response, submitInitialCaseResponseSchema, result, 200);
  });

  router.get("/:case_id/information-requests", requireAuthentication, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const result = await listInformationRequests.execute(authContext.accountId, params.case_id);
    sendValidated(response, listInformationRequestsResponseSchema, result);
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
      sendValidated(response, resubmitCaseResponseSchema, result, 201);
    },
  );

  router.get("/:case_id/messages", requireAuthentication, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const result = await listOwnCaseMessages.execute(authContext.accountId, params.case_id);
    sendValidated(response, listCaseMessagesResponseSchema, result);
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
    sendValidated(response, postCaseMessageResponseSchema, result, 201);
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

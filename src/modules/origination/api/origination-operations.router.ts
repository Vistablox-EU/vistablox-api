import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import {
  AssignPartnerOrganizationService,
  CloseCaseService,
  CreateStaffOriginationCaseService,
  ForceExpireInformationRequestService,
  GetCaseForOperationsService,
  ListCasesForOperationsService,
  PublishInformationRequestService,
  RecordFounderDecisionService,
  RetryPostIpoStructuringHandoffService,
  ReviewEvidenceService,
  SendManualReminderService,
  WithdrawInformationRequestService,
} from "../application/operations-case.service.js";
import {
  ListCaseMessagesForOperationsService,
  PostCaseMessageForOperationsService,
} from "../application/case-message.service.js";
import {
  caseIdParamsSchema,
  informationRequestParamsSchema,
  listCaseMessagesResponseSchema,
  postCaseMessageResponseSchema,
} from "./origination.schemas.js";
import {
  assignPartnerOrganizationBodySchema,
  assignPartnerOrganizationResponseSchema,
  closeCaseBodySchema,
  closeCaseResponseSchema,
  createStaffCaseBodySchema,
  createStaffCaseResponseSchema,
  evidenceReviewParamsSchema,
  forceExpireInformationRequestBodySchema,
  forceExpireInformationRequestResponseSchema,
  founderDecisionBodySchema,
  founderDecisionResponseSchema,
  listCaseMessagesQuerySchema,
  operationsCaseDetailResponseSchema,
  operationsCaseListQuerySchema,
  operationsCaseListResponseSchema,
  postOperationsCaseMessageBodySchema,
  publishInformationRequestBodySchema,
  publishInformationRequestResponseSchema,
  retryPostIpoStructuringHandoffResponseSchema,
  reviewEvidenceBodySchema,
  reviewEvidenceResponseSchema,
  sendManualReminderResponseSchema,
  withdrawInformationRequestBodySchema,
  withdrawInformationRequestResponseSchema,
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
  createStaffCase: CreateStaffOriginationCaseService,
  retryPostIpoStructuringHandoff: RetryPostIpoStructuringHandoffService,
  reviewEvidence: ReviewEvidenceService,
  forceExpireInformationRequest: ForceExpireInformationRequestService,
  sendManualReminder: SendManualReminderService,
  withdrawInformationRequest: WithdrawInformationRequestService,
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

  router.post("/", ...staffOnly, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const body = createStaffCaseBodySchema.parse(request.body);
    const result = await createStaffCase.execute({
      staffAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
      body,
    });
    response.status(201).json(createStaffCaseResponseSchema.parse(result));
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

  router.post(
    "/:case_id/information-requests/:request_id/send-reminder",
    ...staffOnly,
    async (request, response) => {
      const params = informationRequestParamsSchema.parse(request.params);
      const result = await sendManualReminder.execute({
        caseId: params.case_id,
        requestId: params.request_id,
      });
      response.json(sendManualReminderResponseSchema.parse(result));
    },
  );

  router.post(
    "/:case_id/information-requests/:request_id/force-expire",
    ...staffOnly,
    async (request, response) => {
      const authContext = requireAuthContext(response.locals.authContext);
      const params = informationRequestParamsSchema.parse(request.params);
      const body = forceExpireInformationRequestBodySchema.parse(request.body);
      const result = await forceExpireInformationRequest.execute({
        accountId: authContext.accountId,
        caseId: params.case_id,
        requestId: params.request_id,
        traceId: String(response.locals.traceId),
        body,
      });
      response.json(forceExpireInformationRequestResponseSchema.parse(result));
    },
  );

  router.post(
    "/:case_id/information-requests/:request_id/withdraw",
    ...staffOnly,
    async (request, response) => {
      const authContext = requireAuthContext(response.locals.authContext);
      const params = informationRequestParamsSchema.parse(request.params);
      const body = withdrawInformationRequestBodySchema.parse(request.body);
      const result = await withdrawInformationRequest.execute({
        accountId: authContext.accountId,
        caseId: params.case_id,
        requestId: params.request_id,
        traceId: String(response.locals.traceId),
        body,
      });
      response.json(withdrawInformationRequestResponseSchema.parse(result));
    },
  );

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

  router.post("/:case_id/retry-post-ipo-handoff", ...staffOnly, async (request, response) => {
    const params = caseIdParamsSchema.parse(request.params);
    const result = await retryPostIpoStructuringHandoff.execute({
      caseId: params.case_id,
      traceId: String(response.locals.traceId),
    });
    response.json(retryPostIpoStructuringHandoffResponseSchema.parse(result));
  });

  // PUT, not POST: a full replace of the evidence document's review state
  // (status + review_notes together), not an append -- unlike every other
  // subresource action on this router. Purely advisory: this never gates
  // canRecordFounderDecision or anything else, and is reviewable at any
  // case stage (no stage restriction, unlike /decisions and /close above).
  router.put("/:case_id/evidence/:evidence_id/review", ...staffOnly, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = evidenceReviewParamsSchema.parse(request.params);
    const body = reviewEvidenceBodySchema.parse(request.body);
    const result = await reviewEvidence.execute({
      accountId: authContext.accountId,
      caseId: params.case_id,
      evidenceId: params.evidence_id,
      traceId: String(response.locals.traceId),
      body,
    });
    response.json(reviewEvidenceResponseSchema.parse(result));
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

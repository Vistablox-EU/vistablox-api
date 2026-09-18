import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import {
  AssignPartnerOrganizationService,
  CloseCaseService,
  CreateStaffIntakeCaseService,
  CreateStaffDraftCaseService,
  SubmitStaffDraftCaseService,
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
import type { GetOperationsReadinessService } from "../application/get-operations-readiness.service.js";
import type { UploadCaseDocumentService } from "../application/upload-case-document.service.js";
import type { GetCaseDocumentService } from "../application/get-case-document.service.js";
import type { GetIntakeCaseHistoryService, GetIntakeWorkflowService } from "../application/get-intake-workflow.service.js";
import { ApproveIntakeReversalService, GetIntakeReversalOperationService, GetIntakeReversalPreviewService, RequestIntakeReversalService } from "../application/intake-reversal.service.js";
import {
  ListCaseMessagesForOperationsService,
  PostCaseMessageForOperationsService,
} from "../application/case-message.service.js";
import {
  caseIdParamsSchema,
  informationRequestParamsSchema,
  listCaseMessagesResponseSchema,
  postCaseMessageResponseSchema,
} from "./intake.schemas.js";
import {
  assignPartnerOrganizationBodySchema,
  assignPartnerOrganizationResponseSchema,
  closeCaseBodySchema,
  closeCaseResponseSchema,
  createStaffCaseBodySchema,
  createStaffCaseResponseSchema,
  createStaffDraftCaseBodySchema,
  createStaffDraftCaseResponseSchema,
  createStaffDraftSubmitBodySchema,
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
  operationsReadinessResponseSchema,
  reviewEvidenceBodySchema,
  reviewEvidenceResponseSchema,
  roomPhotoParamsSchema,
  roomParamsSchema,
  setRepresentativePhotoBodySchema,
  deleteRoomPhotoBodySchema,
  sendManualReminderResponseSchema,
  withdrawInformationRequestBodySchema,
  withdrawInformationRequestResponseSchema,
  intakeWorkflowResponseSchema,
  intakeHistoryQuerySchema,
  intakeCaseHistoryResponseSchema,
  reversalCommandParamsSchema,
  reversalOperationParamsSchema,
  reversalRequestBodySchema,
  reversalPreviewResponseSchema,
  reversalOperationResponseSchema,
} from "./intake-operations.schemas.js";

export function createIntakeOperationsRouter(
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
  createStaffCase: CreateStaffIntakeCaseService,
  retryPostIpoStructuringHandoff: RetryPostIpoStructuringHandoffService,
  reviewEvidence: ReviewEvidenceService,
  forceExpireInformationRequest: ForceExpireInformationRequestService,
  sendManualReminder: SendManualReminderService,
  withdrawInformationRequest: WithdrawInformationRequestService,
  readiness: GetOperationsReadinessService,
  uploadDocument?: UploadCaseDocumentService,
  documentDownload?: GetCaseDocumentService,
  // Optional: only present once the partner-organizations feature
  // (protectedApi.partnerOrganizations) is configured, unlike everything
  // else on this router, which is unconditional. See app.ts.
  assignPartnerOrganization?: AssignPartnerOrganizationService,
  createStaffDraftCase?: CreateStaffDraftCaseService,
  submitStaffDraftCase?: SubmitStaffDraftCaseService,
  workflow?: GetIntakeWorkflowService,
  history?: GetIntakeCaseHistoryService,
  reversalPreview?: GetIntakeReversalPreviewService,
  requestReversal?: RequestIntakeReversalService,
  approveReversal?: ApproveIntakeReversalService,
  getReversalOperation?: GetIntakeReversalOperationService,
): Router {
  const router = Router();
  const staffOnly = [
    requireAuthentication,
    requireAdminOperations,
    requireStaffWebAuthn,
  ];

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

  if (createStaffDraftCase !== undefined) router.post("/drafts", ...staffOnly, async (request, response) => {
    const body = createStaffDraftCaseBodySchema.parse(request.body);
    const result = await createStaffDraftCase.execute({ body, traceId: String(response.locals.traceId) });
    response.status(201).json(createStaffDraftCaseResponseSchema.parse(result));
  });
  if (submitStaffDraftCase !== undefined) router.post("/:case_id/submit", ...staffOnly, async (request, response) => {
    const params = caseIdParamsSchema.parse(request.params);
    const body = createStaffDraftSubmitBodySchema.parse(request.body);
    response.json(await submitStaffDraftCase.execute({ caseId: params.case_id, traceId: String(response.locals.traceId), body }));
  });

  router.get("/:case_id", ...staffOnly, async (request, response) => {
    const params = caseIdParamsSchema.parse(request.params);
    const result = await getCase.execute(params.case_id);
    response.json(operationsCaseDetailResponseSchema.parse({ data: result }));
  });

  router.get("/:case_id/readiness", ...staffOnly, async (request, response) => {
    const params = caseIdParamsSchema.parse(request.params);
    const startedAt = performance.now();
    const result = operationsReadinessResponseSchema.parse(
      await readiness.execute(params.case_id),
    );
    response.locals.logger?.info(
      {
        case_id: result.data.case_id,
        offering_id: result.data.linked_offering?.offering_id ?? null,
        blocker_codes: result.data.blockers.map((blocker) => blocker.code),
        readiness_latency_ms: Number(
          (performance.now() - startedAt).toFixed(2),
        ),
      },
      "intake readiness evaluated",
    );
    response.json(result);
  });

  if (workflow !== undefined) router.get("/:case_id/workflow", ...staffOnly, async (request, response) => {
    const params = caseIdParamsSchema.parse(request.params);
    response.json(intakeWorkflowResponseSchema.parse(await workflow.execute(params.case_id)));
  });

  if (history !== undefined) router.get("/:case_id/history", ...staffOnly, async (request, response) => {
    const params = caseIdParamsSchema.parse(request.params);
    const query = intakeHistoryQuerySchema.parse(request.query);
    response.json(intakeCaseHistoryResponseSchema.parse(await history.execute({ caseId: params.case_id, limit: query.limit, ...(query.after === undefined ? {} : { after: query.after }) })));
  });

  if (reversalPreview !== undefined) router.get("/:case_id/reversal-preview", ...staffOnly, async (request, response) => {
    const params = reversalCommandParamsSchema.parse(request.params);
    response.json(reversalPreviewResponseSchema.parse(await reversalPreview.execute(params.case_id)));
  });

  if (requestReversal !== undefined) {
    const commands: Array<[string, string]> = [
      ["return-to-draft", "return_to_draft"],
      ["reopen-pre-offering", "reopen_pre_offering"],
      ["reopen-structuring", "reopen_structuring"],
      ["reopen-final-offering-review", "reopen_final_offering_review"],
    ];
    for (const [path, command] of commands) router.post(`/:case_id/commands/${path}`, ...staffOnly, async (request, response) => {
      const params = reversalCommandParamsSchema.parse(request.params);
      const authContext = requireAuthContext(response.locals.authContext);
      const body = reversalRequestBodySchema.parse(request.body);
      const expectedStage = String(request.header("if-match-stage") ?? "");
      const expectedSequence = Number(request.header("if-match-workflow-sequence") ?? "NaN");
      const idempotencyKey = String(request.header("idempotency-key") ?? "").trim();
      if (expectedStage.length === 0 || !Number.isInteger(expectedSequence) || idempotencyKey.length === 0) throw new AppError({ code: "intake.reversal_headers_required", title: "Correction headers required", status: 422, detail: "If-Match-Stage, If-Match-Workflow-Sequence, and Idempotency-Key are required." });
      response.json(reversalOperationResponseSchema.parse(await requestReversal.execute({ caseId: params.case_id, command, accountId: authContext.accountId, traceId: String(response.locals.traceId), idempotencyKey, expectedStage, expectedWorkflowEventSequence: expectedSequence, reasonCode: body.reason_code, reason: body.reason })));
    });
  }

  if (approveReversal !== undefined) router.post("/:case_id/reversal-operations/:operation_id/approve", ...staffOnly, async (request, response) => {
    const params = reversalOperationParamsSchema.parse(request.params);
    const authContext = requireAuthContext(response.locals.authContext);
    response.json(reversalOperationResponseSchema.parse(await approveReversal.execute({ caseId: params.case_id, operationId: params.operation_id, accountId: authContext.accountId, traceId: String(response.locals.traceId) })));
  });
  if (getReversalOperation !== undefined) router.get("/:case_id/reversal-operations/:operation_id", ...staffOnly, async (request, response) => {
    const params = reversalOperationParamsSchema.parse(request.params);
    response.json(reversalOperationResponseSchema.parse(await getReversalOperation.execute({ caseId: params.case_id, operationId: params.operation_id })));
  });

  if (uploadDocument !== undefined) {
    router.post("/:case_id/documents", ...staffOnly, async (request, response) => {
      const params = caseIdParamsSchema.parse(request.params);
      const authContext = requireAuthContext(response.locals.authContext);
      const documentType = String(request.header("x-document-type") ?? "").trim();
      const roomIdHeader = request.header("x-room-id");
      const revisionNumber = Number(request.header("x-revision-number") ?? "1");
      const contentType = request.header("content-type")?.split(";", 1)[0] ?? "application/octet-stream";
      const result = await uploadDocument.execute({ caseId: params.case_id, documentType, revisionNumber, ...(roomIdHeader === undefined ? {} : { roomId: String(roomIdHeader).trim() }), body: request, contentType, originalFilename: String(request.header("x-original-filename") ?? "document"), actorAccountId: authContext.accountId, traceId: String(response.locals.traceId) });
      response.status(201).json({ data: result });
    });
    router.patch("/:case_id/rooms/:room_id/representative-photo", ...staffOnly, async (request, response) => {
      const params = roomParamsSchema.parse(request.params);
      const authContext = requireAuthContext(response.locals.authContext);
      const { document_id: documentId } = setRepresentativePhotoBodySchema.parse(request.body);
      await uploadDocument.setRepresentative({ caseId: params.case_id, roomId: params.room_id, documentId, actorAccountId: authContext.accountId, traceId: String(response.locals.traceId) });
      response.status(204).send();
    });
    router.delete("/:case_id/rooms/:room_id", ...staffOnly, async (request, response) => {
      const params = roomParamsSchema.parse(request.params);
      const authContext = requireAuthContext(response.locals.authContext);
      const body = deleteRoomPhotoBodySchema.parse(request.body ?? {});
      await uploadDocument.deleteRoom({ caseId: params.case_id, roomId: params.room_id, actorAccountId: authContext.accountId, traceId: String(response.locals.traceId), ...(body.reason === undefined ? {} : { reason: body.reason }) });
      response.status(204).send();
    });
    router.delete("/:case_id/rooms/:room_id/photos/:document_id", ...staffOnly, async (request, response) => {
      const params = roomPhotoParamsSchema.parse(request.params);
      const authContext = requireAuthContext(response.locals.authContext);
      const body = deleteRoomPhotoBodySchema.parse(request.body ?? {});
      await uploadDocument.deletePhoto({ caseId: params.case_id, roomId: params.room_id, documentId: params.document_id, actorAccountId: authContext.accountId, traceId: String(response.locals.traceId), ...(body.reason === undefined ? {} : { reason: body.reason }) });
      response.status(204).send();
    });
  }

  if (documentDownload !== undefined) {
    router.get("/:case_id/documents", ...staffOnly, async (request, response) => {
      const params = caseIdParamsSchema.parse(request.params);
      const documentRef = String(request.query.document_ref ?? "");
      if (documentRef.length === 0) {
        const roomId = typeof request.query.room_id === "string" ? request.query.room_id.trim() : undefined;
        const requestedType = typeof request.query.document_type === "string" ? request.query.document_type.trim() : undefined;
        const documents = await documentDownload.list({
          caseId: params.case_id,
          documentType: requestedType ?? (roomId === undefined ? "photo_set" : "room_photo"),
          ...(roomId === undefined ? {} : { roomId }),
        });
        response.json({ data: documents.map((document) => ({ document_id: document.id, document_ref: document.objectKey, document_type: document.documentType, content_type: document.contentType })) });
        return;
      }
      const result = await documentDownload.execute({ caseId: params.case_id, documentRef });
      response
        .type(result.contentType)
        .setHeader("Cache-Control", "private, no-store")
        .setHeader("Content-Length", String(result.sizeBytes));
      // AWS SDK v3 returns Uint8Array from transformToByteArray(). Express
      // treats a bare Uint8Array as a JSON-serializable object, which makes
      // image responses render as broken thumbnails in the Admin. Convert to
      // a Node Buffer so the bytes are sent unchanged with the image MIME.
      response.send(Buffer.from(await result.body.transformToByteArray()));
    });
  }

  router.post(
    "/:case_id/information-requests",
    ...staffOnly,
    async (request, response) => {
      const authContext = requireAuthContext(response.locals.authContext);
      const params = caseIdParamsSchema.parse(request.params);
      const body = publishInformationRequestBodySchema.parse(request.body);
      const result = await publishInformationRequest.execute({
        accountId: authContext.accountId,
        caseId: params.case_id,
        traceId: String(response.locals.traceId),
        body,
      });
      response
        .status(201)
        .json(publishInformationRequestResponseSchema.parse(result));
    },
  );

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

  router.post(
    "/:case_id/decisions",
    ...staffOnly,
    async (request, response) => {
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
    },
  );

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

  router.post(
    "/:case_id/retry-post-ipo-handoff",
    ...staffOnly,
    async (request, response) => {
      const params = caseIdParamsSchema.parse(request.params);
      const result = await retryPostIpoStructuringHandoff.execute({
        caseId: params.case_id,
        traceId: String(response.locals.traceId),
      });
      response.json(retryPostIpoStructuringHandoffResponseSchema.parse(result));
    },
  );

  // PUT, not POST: a full replace of the evidence document's review state
  // (status + review_notes together), not an append -- unlike every other
  // subresource action on this router. Purely advisory: this never gates
  // canRecordFounderDecision or anything else, and is reviewable at any
  // case stage (no stage restriction, unlike /decisions and /close above).
  router.put(
    "/:case_id/evidence/:evidence_id/review",
    ...staffOnly,
    async (request, response) => {
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
    },
  );

  if (assignPartnerOrganization !== undefined) {
    router.post(
      "/:case_id/partner-assignment",
      ...staffOnly,
      async (request, response) => {
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
      },
    );
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

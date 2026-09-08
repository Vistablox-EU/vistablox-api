import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  GetCaseForPartnerService,
  ListCasesForPartnerService,
  RecordAppraisalService,
  RecordLegalStructuringService,
} from "../application/partner-case.service.js";
import { caseIdParamsSchema } from "./origination.schemas.js";
import {
  partnerCaseDetailResponseSchema,
  partnerCaseListQuerySchema,
  partnerCaseListResponseSchema,
  recordAppraisalBodySchema,
  recordAppraisalResponseSchema,
  recordLegalStructuringBodySchema,
  recordLegalStructuringResponseSchema,
} from "./partner-case.schemas.js";

// Twin of partner-organization.router.ts's createLegalPracticeRouter /
// createAppraisalFirmRouter split: legal and appraisal partners share the
// same list/detail mechanics but each gets its own writeback shape, so two
// mirror-image routers stay simpler than one branching on role at runtime.
export function createLegalPartnerCaseRouter(
  requireAuthentication: RequestHandler,
  requireLegalPartner: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  // Pre-built via createRequirePartnerCaseAssignment("legal_partner", ...)
  // at the call site -- this router only wires handlers, it doesn't hold
  // the account/case repositories that middleware needs to run.
  requirePartnerCaseAssignment: RequestHandler,
  listCases: ListCasesForPartnerService,
  getCase: GetCaseForPartnerService,
  recordLegalStructuring: RecordLegalStructuringService,
): Router {
  const router = Router();
  const roleGated = [requireAuthentication, requireLegalPartner, requireStaffWebAuthn];

  router.get("/", ...roleGated, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const query = partnerCaseListQuerySchema.parse(request.query);
    const result = await listCases.execute({ accountId: authContext.accountId, query });
    response.json(partnerCaseListResponseSchema.parse(result));
  });

  router.get("/:case_id", ...roleGated, requirePartnerCaseAssignment, async (request, response) => {
    const params = caseIdParamsSchema.parse(request.params);
    const result = await getCase.execute(params.case_id);
    response.json(partnerCaseDetailResponseSchema.parse(result));
  });

  router.patch("/:case_id", ...roleGated, requirePartnerCaseAssignment, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const body = recordLegalStructuringBodySchema.parse(request.body);
    const result = await recordLegalStructuring.execute({
      caseId: params.case_id,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
      body,
    });
    response.json(recordLegalStructuringResponseSchema.parse(result));
  });

  return router;
}

export function createAppraisalPartnerCaseRouter(
  requireAuthentication: RequestHandler,
  requireAppraisalPartner: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  requirePartnerCaseAssignment: RequestHandler,
  listCases: ListCasesForPartnerService,
  getCase: GetCaseForPartnerService,
  recordAppraisal: RecordAppraisalService,
): Router {
  const router = Router();
  const roleGated = [requireAuthentication, requireAppraisalPartner, requireStaffWebAuthn];

  router.get("/", ...roleGated, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const query = partnerCaseListQuerySchema.parse(request.query);
    const result = await listCases.execute({ accountId: authContext.accountId, query });
    response.json(partnerCaseListResponseSchema.parse(result));
  });

  router.get("/:case_id", ...roleGated, requirePartnerCaseAssignment, async (request, response) => {
    const params = caseIdParamsSchema.parse(request.params);
    const result = await getCase.execute(params.case_id);
    response.json(partnerCaseDetailResponseSchema.parse(result));
  });

  router.patch("/:case_id", ...roleGated, requirePartnerCaseAssignment, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = caseIdParamsSchema.parse(request.params);
    const body = recordAppraisalBodySchema.parse(request.body);
    const result = await recordAppraisal.execute({
      caseId: params.case_id,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
      body,
    });
    response.json(recordAppraisalResponseSchema.parse(result));
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

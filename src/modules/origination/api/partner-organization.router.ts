import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  CreateAppraisalFirmService,
  CreateLegalPracticeService,
  ListAppraisalFirmsService,
  ListLegalPracticesService,
  UpdateAppraisalFirmStatusService,
  UpdateLegalPracticeStatusService,
} from "../application/partner-organization.service.js";
import {
  appraisalFirmParamsSchema,
  appraisalFirmResponseSchema,
  createAppraisalFirmBodySchema,
  createLegalPracticeBodySchema,
  legalPracticeParamsSchema,
  legalPracticeResponseSchema,
  listAppraisalFirmsResponseSchema,
  listLegalPracticesResponseSchema,
  updateAppraisalFirmStatusBodySchema,
  updateLegalPracticeStatusBodySchema,
} from "./partner-organization.schemas.js";

export function createLegalPracticeRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  createLegalPractice: CreateLegalPracticeService,
  listLegalPractices: ListLegalPracticesService,
  updateLegalPracticeStatus: UpdateLegalPracticeStatusService,
): Router {
  const router = Router();
  const authorization = [requireAuthentication, requireAdminOperations, requireStaffWebAuthn];

  router.get("/", ...authorization, async (_request, response) => {
    const result = await listLegalPractices.execute();
    response.setHeader("Cache-Control", "no-store");
    response.json(listLegalPracticesResponseSchema.parse(result));
  });

  router.post("/", ...authorization, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) throw missingContextError();
    const body = createLegalPracticeBodySchema.parse(request.body);
    const result = await createLegalPractice.execute({
      name: body.name,
      countryCode: body.country_code,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
    });
    response.status(201).json(legalPracticeResponseSchema.parse(result));
  });

  router.patch("/:legal_practice_id/status", ...authorization, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) throw missingContextError();
    const params = legalPracticeParamsSchema.parse(request.params);
    const body = updateLegalPracticeStatusBodySchema.parse(request.body);
    const result = await updateLegalPracticeStatus.execute({
      id: params.legal_practice_id,
      status: body.status,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
    });
    response.json(legalPracticeResponseSchema.parse(result));
  });

  return router;
}

export function createAppraisalFirmRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  createAppraisalFirm: CreateAppraisalFirmService,
  listAppraisalFirms: ListAppraisalFirmsService,
  updateAppraisalFirmStatus: UpdateAppraisalFirmStatusService,
): Router {
  const router = Router();
  const authorization = [requireAuthentication, requireAdminOperations, requireStaffWebAuthn];

  router.get("/", ...authorization, async (_request, response) => {
    const result = await listAppraisalFirms.execute();
    response.setHeader("Cache-Control", "no-store");
    response.json(listAppraisalFirmsResponseSchema.parse(result));
  });

  router.post("/", ...authorization, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) throw missingContextError();
    const body = createAppraisalFirmBodySchema.parse(request.body);
    const result = await createAppraisalFirm.execute({
      name: body.name,
      countryCode: body.country_code,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
    });
    response.status(201).json(appraisalFirmResponseSchema.parse(result));
  });

  router.patch("/:appraisal_firm_id/status", ...authorization, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) throw missingContextError();
    const params = appraisalFirmParamsSchema.parse(request.params);
    const body = updateAppraisalFirmStatusBodySchema.parse(request.body);
    const result = await updateAppraisalFirmStatus.execute({
      id: params.appraisal_firm_id,
      status: body.status,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
    });
    response.json(appraisalFirmResponseSchema.parse(result));
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

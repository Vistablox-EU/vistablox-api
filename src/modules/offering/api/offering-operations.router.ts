import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { ClassifyMaterialityService } from "../application/classify-materiality.service.js";
import type { FinalizeOfferingService } from "../application/finalize-offering.service.js";
import type { PublishDisclosurePackService } from "../application/publish-disclosure-pack.service.js";
import { investorOfferingParamsSchema } from "./offering.schemas.js";
import {
  classifyMaterialityBodySchema,
  classifyMaterialityResponseSchema,
  finalizeOfferingBodySchema,
  finalizeOfferingResponseSchema,
  publishDisclosurePackBodySchema,
  publishDisclosurePackResponseSchema,
} from "./offering-operations.schemas.js";

export function createOfferingOperationsRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  finalizeOffering: FinalizeOfferingService,
  classifyMateriality: ClassifyMaterialityService,
  publishDisclosurePack: PublishDisclosurePackService,
): Router {
  const router = Router();
  const staffOnly = [requireAuthentication, requireAdminOperations, requireStaffWebAuthn];

  router.post("/:offering_id/finalize", ...staffOnly, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = investorOfferingParamsSchema.parse(request.params);
    const body = finalizeOfferingBodySchema.parse(request.body);
    const result = await finalizeOffering.execute({
      accountId: authContext.accountId,
      offeringId: params.offering_id,
      traceId: String(response.locals.traceId),
      body,
    });
    response.json(finalizeOfferingResponseSchema.parse(result));
  });

  router.post("/:offering_id/materiality-records", ...staffOnly, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = investorOfferingParamsSchema.parse(request.params);
    const body = classifyMaterialityBodySchema.parse(request.body);
    const result = await classifyMateriality.execute({
      accountId: authContext.accountId,
      offeringId: params.offering_id,
      traceId: String(response.locals.traceId),
      body,
    });
    response.status(201).json(classifyMaterialityResponseSchema.parse(result));
  });

  router.post("/:offering_id/disclosure-packs", ...staffOnly, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = investorOfferingParamsSchema.parse(request.params);
    const body = publishDisclosurePackBodySchema.parse(request.body);
    const result = await publishDisclosurePack.execute({
      accountId: authContext.accountId,
      offeringId: params.offering_id,
      traceId: String(response.locals.traceId),
      body,
    });
    response.status(201).json(publishDisclosurePackResponseSchema.parse(result));
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

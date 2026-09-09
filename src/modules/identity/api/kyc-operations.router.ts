import { Router, type RequestHandler } from "express";

import type { KycServiceGateway } from "../application/kyc-service-gateway.js";
import { kycAccountIdParamsSchema, operationsKycAccountResponseSchema } from "./kyc.schemas.js";

export function createKycOperationsRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  gateway: KycServiceGateway,
): Router {
  const router = Router();
  const staffOnly = [requireAuthentication, requireAdminOperations, requireStaffWebAuthn];

  router.get("/:account_id", ...staffOnly, async (request, response) => {
    const params = kycAccountIdParamsSchema.parse(request.params);
    const result = await gateway.getAccountForOperations(params.account_id);
    response.setHeader("Cache-Control", "no-store");
    response.json(operationsKycAccountResponseSchema.parse(result));
  });

  return router;
}

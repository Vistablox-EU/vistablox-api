import { Router, type RequestHandler } from "express";

import type { GetKycAccountForOperationsService } from "../application/kyc.service.js";
import { kycAccountIdParamsSchema, operationsKycAccountResponseSchema } from "./kyc.schemas.js";

// Reversal (undoing the KYC microservice split): calls the concrete
// service directly, in-process. account_id from the path param is fine
// here, unchanged -- this route is staff-only (WebAuthn-gated), the same
// "trusted, already-authorized caller supplies an arbitrary account_id"
// shape kyc-internal.router.ts's own equivalent route always had.
export function createKycOperationsRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  getAccountForOperations: GetKycAccountForOperationsService,
): Router {
  const router = Router();
  const staffOnly = [requireAuthentication, requireAdminOperations, requireStaffWebAuthn];

  router.get("/:account_id", ...staffOnly, async (request, response) => {
    const params = kycAccountIdParamsSchema.parse(request.params);
    const result = await getAccountForOperations.execute(params.account_id);
    response.setHeader("Cache-Control", "no-store");
    response.json(operationsKycAccountResponseSchema.parse(result));
  });

  return router;
}

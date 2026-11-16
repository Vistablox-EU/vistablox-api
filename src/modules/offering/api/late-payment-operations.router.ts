import { Router, type RequestHandler } from "express";

import type { ListLatePaymentsService } from "../application/list-late-payments.service.js";
import { latePaymentListQuerySchema, latePaymentListResponseSchema } from "./late-payment-operations.schemas.js";

/**
 * Staff view of provider payments that arrived after their reservation had
 * lapsed or been cancelled (issue #168). Read-only: the manual-review policy
 * has no resolve action yet, see docs/investor-offering.md "Late payments".
 */
export function createLatePaymentOperationsRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  listLatePayments: ListLatePaymentsService,
): Router {
  const router = Router();
  const staffOnly = [requireAuthentication, requireAdminOperations, requireStaffWebAuthn];

  router.get("/", ...staffOnly, async (request, response) => {
    const query = latePaymentListQuerySchema.parse(request.query);
    const result = await listLatePayments.execute(query);
    response.json(latePaymentListResponseSchema.parse(result));
  });

  return router;
}

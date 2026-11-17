import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { ListOnrampLateEvidenceService } from "../application/list-onramp-late-evidence.service.js";
import type { MarkOnrampLateEvidenceReviewedService } from "../application/mark-onramp-late-evidence-reviewed.service.js";
import {
  markOnrampLateEvidenceReviewedResponseSchema,
  onrampLateEvidenceListQuerySchema,
  onrampLateEvidenceListResponseSchema,
  onrampLateEvidenceParamsSchema,
} from "./onramp-late-evidence.schemas.js";

/**
 * Staff view of late onramp funding evidence (AD-288, decided 2026-11-17; issue
 * #168): Coinbase successes for reservations that had already left 'initiated'.
 * Staff can read the list and mark an entry reviewed, and that is all: the EURC
 * is already in the investor's wallet, so there is nothing to hold, reinstate
 * or refund (docs/investor-offering.md "Late payments").
 */
export function createOnrampLateEvidenceRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  listEvidence: ListOnrampLateEvidenceService,
  markReviewed: MarkOnrampLateEvidenceReviewedService,
): Router {
  const router = Router();
  const staffOnly = [requireAuthentication, requireAdminOperations, requireStaffWebAuthn];

  router.get("/", ...staffOnly, async (request, response) => {
    const query = onrampLateEvidenceListQuerySchema.parse(request.query);
    const result = await listEvidence.execute(query);
    response.json(onrampLateEvidenceListResponseSchema.parse(result));
  });

  router.post("/:evidence_id/mark-reviewed", ...staffOnly, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) {
      throw new AppError({
        code: "authentication.context_missing",
        title: "Authentication unavailable",
        status: 500,
        detail: "The authenticated account context is unavailable.",
      });
    }
    const params = onrampLateEvidenceParamsSchema.parse(request.params);
    const result = await markReviewed.execute({
      accountId: authContext.accountId,
      evidenceId: params.evidence_id,
      traceId: String(response.locals.traceId),
    });
    response.json(markOnrampLateEvidenceReviewedResponseSchema.parse(result));
  });

  return router;
}

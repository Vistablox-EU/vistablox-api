import { Router, type RequestHandler } from "express";

import { AppError } from "../../../../shared/errors/app-error.js";
import type { IssueStaffInvitationService } from "../../application/staff/staff-invitation.service.js";
import {
  issueStaffInvitationBodySchema,
  issueStaffInvitationResponseSchema,
} from "./staff-invitation-issue.schemas.js";

export function createInternalStaffInvitationRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  issueInvitation: IssueStaffInvitationService,
): Router {
  const router = Router();
  router.post(
    "/",
    requireAuthentication,
    requireAdminOperations,
    requireStaffWebAuthn,
    async (request, response) => {
      const authContext = response.locals.authContext;
      if (authContext === undefined) throw missingContextError();
      const body = issueStaffInvitationBodySchema.parse(request.body);
      const result = await issueInvitation.execute({
        actorAccountId: authContext.accountId,
        traceId: String(response.locals.traceId),
        email: body.email,
        displayName: body.display_name,
        role: body.role,
        legalPracticeId: body.legal_practice_id,
        appraisalFirmId: body.appraisal_firm_id,
      });
      response.status(201).json(issueStaffInvitationResponseSchema.parse(result));
    },
  );
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
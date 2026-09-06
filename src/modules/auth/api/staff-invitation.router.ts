import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import {
  AcceptStaffInvitationService,
  IssueStaffInvitationService,
} from "../application/staff-invitation.service.js";
import {
  acceptStaffInvitationBodySchema,
  acceptStaffInvitationResponseSchema,
  issueStaffInvitationBodySchema,
  issueStaffInvitationResponseSchema,
} from "./staff-invitation.schemas.js";

export function createPublicStaffInvitationRouter(
  acceptInvitation: AcceptStaffInvitationService,
): Router {
  const router = Router();
  router.post("/accept", async (request, response) => {
    const body = acceptStaffInvitationBodySchema.parse(request.body);
    const result = await acceptInvitation.execute({
      token: body.token,
      traceId: String(response.locals.traceId),
    });
    response.json(acceptStaffInvitationResponseSchema.parse(result));
  });
  return router;
}

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

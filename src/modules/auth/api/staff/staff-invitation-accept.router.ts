import { Router } from "express";

import {
  acceptStaffInvitationBodySchema,
  acceptStaffInvitationResponseSchema,
} from "./staff-invitation-accept.schemas.js";
import type { AcceptStaffInvitationService } from "../../application/staff/staff-invitation.service.js";

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
import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import { StaffWebAuthnService } from "../application/staff-webauthn.service.js";
import {
  finishAuthenticationBodySchema,
  finishCeremonyResponseSchema,
  finishRegistrationBodySchema,
  startCeremonyResponseSchema,
  startRegistrationBodySchema,
} from "./staff-webauthn.schemas.js";

export function createStaffWebAuthnRouter(
  requireAuthentication: RequestHandler,
  requireStaffIdentity: RequestHandler,
  service: StaffWebAuthnService,
): Router {
  const router = Router();
  const staffSession = [requireAuthentication, requireStaffIdentity];

  router.post("/registration/options", ...staffSession, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const body = startRegistrationBodySchema.parse(request.body);
    const result = await service.startRegistration({
      accountId: authContext.accountId,
      providerSessionId: authContext.providerSessionId,
      credentialLabel: body.credential_label,
    });
    response.json(startCeremonyResponseSchema.parse(result));
  });

  router.post("/registration/verify", ...staffSession, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const body = finishRegistrationBodySchema.parse(request.body);
    const result = await service.finishRegistration({
      accountId: authContext.accountId,
      providerSessionId: authContext.providerSessionId,
      traceId: String(response.locals.traceId),
      challengeId: body.challenge_id,
      response: body.response,
    });
    response.json(finishCeremonyResponseSchema.parse(result));
  });

  router.post("/authentication/options", ...staffSession, async (_request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const result = await service.startAuthentication({
      accountId: authContext.accountId,
      providerSessionId: authContext.providerSessionId,
    });
    response.json(startCeremonyResponseSchema.parse(result));
  });

  router.post("/authentication/verify", ...staffSession, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const body = finishAuthenticationBodySchema.parse(request.body);
    const result = await service.finishAuthentication({
      accountId: authContext.accountId,
      providerSessionId: authContext.providerSessionId,
      traceId: String(response.locals.traceId),
      challengeId: body.challenge_id,
      response: body.response,
    });
    response.json(finishCeremonyResponseSchema.parse(result));
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

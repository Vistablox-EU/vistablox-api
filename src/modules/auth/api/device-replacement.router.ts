import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  RequestDeviceReplacementService,
  VerifyDeviceReplacementService,
} from "../application/device-replacement.service.js";
import { deviceReplacementVerifyRequestSchema } from "./device-replacement.schemas.js";

/**
 * `/v1/auth/mobile/replacement/*` (AD-271): self-service device replacement.
 * Both routes require a valid customer session (requireAuthentication); the
 * request issues an email code and the verify spends it to revoke the active
 * device, so the customer can enrol a new device after a reinstall or new
 * phone without staff. No SMS — the second factor is email to the bound
 * protected_contact_email.
 */
export function createDeviceReplacementRouter(
  requireAuthentication: RequestHandler,
  requestReplacement: RequestDeviceReplacementService,
  verifyReplacement: VerifyDeviceReplacementService,
): Router {
  const router = Router();

  // Body is empty: the session and bound email identify the account. Returns
  // 202 with no body so the response never reveals whether an email is bound.
  router.post("/request", requireAuthentication, async (_request, response) => {
    const authContext = requireAuthContext(response);
    await requestReplacement.execute({
      accountId: authContext.accountId,
      sessionId: authContext.providerSessionId,
      traceId: String(response.locals.traceId),
    });
    response.status(202).end();
  });

  router.post("/verify", requireAuthentication, async (request, response) => {
    const authContext = requireAuthContext(response);
    const body = deviceReplacementVerifyRequestSchema.parse(request.body);
    await verifyReplacement.execute({
      accountId: authContext.accountId,
      sessionId: authContext.providerSessionId,
      code: body.code,
      traceId: String(response.locals.traceId),
    });
    response.status(204).end();
  });

  return router;
}

interface AuthContext {
  accountId: string;
  providerSessionId: string;
}

function requireAuthContext(response: import("express").Response): AuthContext {
  const authContext = response.locals.authContext;
  if (authContext === undefined || typeof authContext.accountId !== "string") {
    throw new AppError({
      code: "authentication.context_missing",
      title: "Authentication unavailable",
      status: 500,
      detail: "The authenticated account context is unavailable.",
    });
  }
  return authContext as AuthContext;
}

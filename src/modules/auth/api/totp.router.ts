import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { EnrollTotpService, VerifyTotpService } from "../application/totp.service.js";
import {
  enrollTotpResponseSchema,
  verifyTotpBodySchema,
  verifyTotpResponseSchema,
} from "./totp.schemas.js";

export function createTotpRouter(
  requireAuthentication: RequestHandler,
  enrollTotp: EnrollTotpService,
  verifyTotp: VerifyTotpService,
): Router {
  const router = Router();

  router.post("/enroll", requireAuthentication, async (_request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const result = await enrollTotp.execute(context.accountId);
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json(
      enrollTotpResponseSchema.parse({
        data: {
          otp_auth_uri: result.otpAuthUri,
          secret: result.secret,
          backup_codes: result.backupCodes,
        },
      }),
    );
  });

  router.post("/verify", requireAuthentication, async (request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const body = verifyTotpBodySchema.parse(request.body);
    const result = await verifyTotp.execute(context.accountId, body.code);
    response.json(
      verifyTotpResponseSchema.parse({
        data: { verified: result.verified, method: result.method },
      }),
    );
  });

  return router;
}

function requireCustomerContext(
  context: { accountId: string; population: string } | undefined,
): { accountId: string } {
  if (context === undefined) {
    throw new AppError({
      code: "authentication.context_missing",
      title: "Authentication unavailable",
      status: 500,
      detail: "The authenticated account context is unavailable.",
    });
  }
  if (context.population !== "customer") {
    throw new AppError({
      code: "authorization.forbidden",
      title: "Action not permitted",
      status: 403,
      detail: "TOTP enrollment is available only to customer accounts.",
    });
  }
  return { accountId: context.accountId };
}

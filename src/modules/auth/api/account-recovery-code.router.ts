import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  RedeemAccountRecoveryCodeService,
  RotateAccountRecoveryCodeService,
} from "../application/account-recovery-code.service.js";
import {
  redeemAccountRecoveryCodeBodySchema,
  redeemAccountRecoveryCodeResponseSchema,
  rotateAccountRecoveryCodeResponseSchema,
} from "./account-recovery-code.schemas.js";

export function createAccountRecoveryCodeRouter(
  requireAuthentication: RequestHandler,
  requireOAuthBootstrapAuthentication: RequestHandler,
  requireFreshAuthentication: RequestHandler,
  rotateCode: RotateAccountRecoveryCodeService,
  redeemCode: RedeemAccountRecoveryCodeService,
): Router {
  const router = Router();

  router.post(
    "/rotate",
    requireAuthentication,
    requireFreshAuthentication,
    async (_request, response) => {
      const accountId = requireCustomerAccountId(response.locals.authContext);
      const result = await rotateCode.execute(accountId);
      response.setHeader("Cache-Control", "no-store");
      response.status(201).json(
        rotateAccountRecoveryCodeResponseSchema.parse({
          data: { code: result.code, created_at: result.createdAt.toISOString() },
        }),
      );
    },
  );

  router.post("/redeem", requireOAuthBootstrapAuthentication, async (request, response) => {
    const accountId = requireCustomerAccountId(response.locals.authContext);
    const body = redeemAccountRecoveryCodeBodySchema.parse(request.body);
    const result = await redeemCode.execute({ accountId, code: body.code });
    response.setHeader("Cache-Control", "no-store");
    response.json(
      redeemAccountRecoveryCodeResponseSchema.parse({
        data: { passkey_registration_context: result.passkeyRegistrationContext },
      }),
    );
  });

  return router;
}

function requireCustomerAccountId(context: Express.Locals["authContext"]): string {
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
      detail: "Recovery codes are available only to customer accounts.",
    });
  }
  return context.accountId;
}

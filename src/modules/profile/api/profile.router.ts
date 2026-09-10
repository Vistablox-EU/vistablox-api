import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { GetProfileService } from "../application/get-profile.service.js";
import type { UpdateAccountPreferencesService } from "../application/update-account-preferences.service.js";
import {
  profileResponseSchema,
  updateAccountPreferencesBodySchema,
  updateAccountPreferencesResponseSchema,
} from "./profile.schemas.js";

export function createProfileRouter(
  requireAuthentication: RequestHandler,
  getProfile: GetProfileService,
  updateAccountPreferences: UpdateAccountPreferencesService,
): Router {
  const router = Router();
  router.get("/", requireAuthentication, async (_request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const result = await getProfile.execute(context.accountId);
    response.setHeader("Cache-Control", "no-store");
    response.json(profileResponseSchema.parse(result));
  });
  router.patch("/preferences", requireAuthentication, async (request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const body = updateAccountPreferencesBodySchema.parse(request.body);
    const result = await updateAccountPreferences.execute(context.accountId, {
      ...(body.deal_alerts_email === undefined ? {} : { dealAlertsEmail: body.deal_alerts_email }),
      ...(body.statements_email === undefined ? {} : { statementsEmail: body.statements_email }),
      ...(body.marketing_email === undefined ? {} : { marketingEmail: body.marketing_email }),
      ...(body.locale === undefined ? {} : { locale: body.locale }),
      ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
    });
    response.setHeader("Cache-Control", "no-store");
    response.json(updateAccountPreferencesResponseSchema.parse(result));
  });
  return router;
}

function requireCustomerContext(
  context: Express.Locals["authContext"],
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
      detail: "Investor profiles are available only to customer accounts.",
    });
  }
  return { accountId: context.accountId };
}

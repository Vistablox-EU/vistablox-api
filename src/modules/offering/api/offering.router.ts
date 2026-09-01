import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { GetInvestorOfferingService } from "../application/get-investor-offering.service.js";
import { ListPublicOfferingsService } from "../application/list-public-offerings.service.js";
import {
  investorOfferingDetailResponseSchema,
  investorOfferingParamsSchema,
  listOfferingsQuerySchema,
  listOfferingsResponseSchema,
} from "./offering.schemas.js";

export function createOfferingRouter(service: ListPublicOfferingsService): Router {
  const router = Router();

  router.get("/", async (request, response) => {
    const query = listOfferingsQuerySchema.parse(request.query);
    const result = await service.execute(query);
    response.json(listOfferingsResponseSchema.parse(result));
  });

  return router;
}

export function createInvestorOfferingRouter(
  requireAuthentication: RequestHandler,
  service: GetInvestorOfferingService,
): Router {
  const router = Router();

  router.get("/:offering_id", requireAuthentication, async (request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const params = investorOfferingParamsSchema.parse(request.params);
    const result = await service.execute({
      offeringId: params.offering_id,
      accountId: context.accountId,
    });
    response.setHeader("Cache-Control", "no-store");
    response.json(investorOfferingDetailResponseSchema.parse(result));
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
      detail: "Full offering details are available only to customer accounts.",
    });
  }
  return { accountId: context.accountId };
}

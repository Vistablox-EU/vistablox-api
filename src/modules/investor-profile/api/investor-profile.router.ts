import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { GetInvestorProfileService } from "../application/get-investor-profile.service.js";
import type {
  ListInvestorCurrentPositionsService,
  ListInvestorReservationsService,
} from "../application/list-investor-activity.service.js";
import {
  investorActivityQuerySchema,
  investorCurrentPositionsResponseSchema,
  investorProfileResponseSchema,
  investorReservationHistoryResponseSchema,
} from "./investor-profile.schemas.js";

export function createInvestorProfileRouter(
  requireAuthentication: RequestHandler,
  getProfile: GetInvestorProfileService,
  listReservations: ListInvestorReservationsService,
  listCurrentPositions: ListInvestorCurrentPositionsService,
): Router {
  const router = Router();
  router.get("/", requireAuthentication, async (_request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const result = await getProfile.execute(context.accountId);
    response.setHeader("Cache-Control", "no-store");
    response.json(investorProfileResponseSchema.parse(result));
  });
  router.get("/reservations", requireAuthentication, async (request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const query = investorActivityQuerySchema.parse(request.query);
    const result = await listReservations.execute({
      accountId: context.accountId,
      query,
    });
    response.setHeader("Cache-Control", "no-store");
    response.json(investorReservationHistoryResponseSchema.parse(result));
  });
  router.get("/positions", requireAuthentication, async (request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const query = investorActivityQuerySchema.parse(request.query);
    const result = await listCurrentPositions.execute({
      accountId: context.accountId,
      query,
    });
    response.setHeader("Cache-Control", "no-store");
    response.json(investorCurrentPositionsResponseSchema.parse(result));
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
      detail: "Investor profiles are available only to customer accounts.",
    });
  }
  return { accountId: context.accountId };
}

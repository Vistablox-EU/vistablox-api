import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  ListInvestorCurrentPositionsService,
  ListInvestorReservationsService,
} from "../application/list-investor-activity.service.js";
import {
  investorActivityQuerySchema,
  investorCurrentPositionsResponseSchema,
  investorReservationHistoryResponseSchema,
} from "./investor-activity.schemas.js";

export function createInvestorActivityRouter(
  requireAuthentication: RequestHandler,
  listReservations: ListInvestorReservationsService,
  listCurrentPositions: ListInvestorCurrentPositionsService,
): Router {
  const router = Router();
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

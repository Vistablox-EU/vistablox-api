import { pipeline } from "node:stream/promises";

import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { CreateReservationService } from "../application/create-reservation.service.js";
import type { DownloadDisclosureDocumentService } from "../application/download-disclosure-document.service.js";
import type { GetInvestorOfferingService } from "../application/get-investor-offering.service.js";
import type { ReconfirmReservationService } from "../application/reconfirm-reservation.service.js";
import { ListPublicOfferingsService } from "../application/list-public-offerings.service.js";
import {
  createReservationBodySchema,
  createReservationResponseSchema,
  disclosureDocumentParamsSchema,
  investorOfferingDetailResponseSchema,
  investorOfferingParamsSchema,
  listOfferingsQuerySchema,
  listOfferingsResponseSchema,
  reconfirmReservationResponseSchema,
  reservationParamsSchema,
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
  downloadDocument?: DownloadDisclosureDocumentService,
  createReservation?: CreateReservationService,
  reconfirmReservation?: ReconfirmReservationService,
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

  if (createReservation !== undefined) {
    router.post("/:offering_id/reservations", requireAuthentication, async (request, response) => {
      const context = requireCustomerContext(response.locals.authContext);
      const params = investorOfferingParamsSchema.parse(request.params);
      const body = createReservationBodySchema.parse(request.body);
      const result = await createReservation.execute({
        offeringId: params.offering_id,
        accountId: context.accountId,
        amountEur: body.amount_eur,
        traceId: String(response.locals.traceId),
      });
      response.setHeader("Cache-Control", "no-store");
      response.status(201).json(createReservationResponseSchema.parse(result));
    });
  }

  if (reconfirmReservation !== undefined) {
    router.post(
      "/:offering_id/reservations/:reservation_id/reconfirm",
      requireAuthentication,
      async (request, response) => {
        const context = requireCustomerContext(response.locals.authContext);
        const params = reservationParamsSchema.parse(request.params);
        const result = await reconfirmReservation.execute({
          accountId: context.accountId,
          reservationId: params.reservation_id,
          traceId: String(response.locals.traceId),
        });
        response.setHeader("Cache-Control", "no-store");
        response.json(reconfirmReservationResponseSchema.parse(result));
      },
    );
  }

  if (downloadDocument !== undefined) {
    router.get(
      "/:offering_id/documents/:document_id/download",
      requireAuthentication,
      async (request, response) => {
        const context = requireCustomerContext(response.locals.authContext);
        const params = disclosureDocumentParamsSchema.parse(request.params);
        const download = await downloadDocument.execute({
          accountId: context.accountId,
          offeringId: params.offering_id,
          documentId: params.document_id,
        });
        response.setHeader("Cache-Control", "private, no-store");
        response.setHeader("Content-Type", download.contentType);
        response.setHeader("Content-Length", String(download.contentLength));
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="${contentDispositionFileName(download.fileName)}"`,
        );
        response.setHeader("X-Content-Type-Options", "nosniff");
        await pipeline(download.body, response);
      },
    );
  }

  return router;
}

function contentDispositionFileName(value: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return safe || "disclosure-document";
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

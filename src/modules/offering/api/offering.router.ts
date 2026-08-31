import { Router } from "express";

import { ListPublicOfferingsService } from "../application/list-public-offerings.service.js";
import { listOfferingsQuerySchema, listOfferingsResponseSchema } from "./offering.schemas.js";

export function createOfferingRouter(service: ListPublicOfferingsService): Router {
  const router = Router();

  router.get("/", async (request, response) => {
    const query = listOfferingsQuerySchema.parse(request.query);
    const result = await service.execute(query);
    response.json(listOfferingsResponseSchema.parse(result));
  });

  return router;
}

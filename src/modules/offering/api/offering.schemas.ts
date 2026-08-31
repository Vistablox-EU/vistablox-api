import { z } from "zod";

import { publicOfferingStatuses } from "../domain/public-offering.policy.js";

export const listOfferingsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).optional(),
});

export const publicOfferingSchema = z.object({
  id: z.string(),
  status: z.enum(publicOfferingStatuses),
  target_raise_eur: z.string().regex(/^\d+\.\d{2}$/),
  ipo_end_at: z.iso.datetime().nullable(),
  property: z.object({
    property_type: z.literal("residential"),
    country_code: z.string().length(2),
    city: z.string().nullable(),
  }),
});

export const listOfferingsResponseSchema = z.object({
  data: z.array(publicOfferingSchema),
  page: z.object({
    next_cursor: z.string().nullable(),
  }),
});

export type ListOfferingsQuery = z.infer<typeof listOfferingsQuerySchema>;
export type ListOfferingsResponse = z.infer<typeof listOfferingsResponseSchema>;

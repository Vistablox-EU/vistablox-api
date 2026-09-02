import { z } from "zod";

export const finalizeOfferingBodySchema = z.object({
  founder_review_notes: z.string().trim().min(1).max(10000),
});

export const finalizeOfferingResponseSchema = z.object({
  data: z.object({
    offering_id: z.string().min(1),
    status: z.literal("final_offering"),
    final_offering_published_at: z.iso.datetime(),
    positions_created: z.number().int().min(0),
    reservations_cancelled: z.number().int().min(0),
  }),
});

export type FinalizeOfferingBody = z.infer<typeof finalizeOfferingBodySchema>;
export type FinalizeOfferingResponse = z.infer<typeof finalizeOfferingResponseSchema>;

import { z } from "zod";

import { materialityClassifications, materialityThresholdTypes } from "../domain/materiality.policy.js";

export const finalizeOfferingBodySchema = z.object({
  founder_review_notes: z.string().trim().min(1).max(10000),
});

export const finalizeOfferingResponseSchema = z.object({
  data: z.object({
    offering_id: z.string().min(1),
    final_offering_published_at: z.iso.datetime(),
    effective_rights_end_at: z.iso.datetime(),
    reservations_awaiting_reconfirmation: z.number().int().min(0),
    reservations_cancelled: z.number().int().min(0),
  }),
});

export type FinalizeOfferingBody = z.infer<typeof finalizeOfferingBodySchema>;
export type FinalizeOfferingResponse = z.infer<typeof finalizeOfferingResponseSchema>;

export const classifyMaterialityBodySchema = z
  .object({
    change_description: z.string().trim().min(1).max(10000),
    classification: z.enum(materialityClassifications),
    threshold_type: z.enum(materialityThresholdTypes).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    // CORE_TABLES.md: threshold_type only means something "when
    // reviewed_material" — per_se_material is material by category, not by
    // crossing a threshold, and non_material has no threshold to record.
    if (value.threshold_type !== null && value.classification !== "reviewed_material") {
      ctx.addIssue({
        code: "custom",
        path: ["threshold_type"],
        message: "threshold_type may only be set when classification is reviewed_material.",
      });
    }
  });

export const classifyMaterialityResponseSchema = z.object({
  data: z.object({
    materiality_record_id: z.string().min(1),
    offering_id: z.string().min(1),
    classification: z.enum(materialityClassifications),
    threshold_type: z.enum(materialityThresholdTypes).nullable(),
    reset_triggered: z.boolean(),
    classified_at: z.iso.datetime(),
    effective_rights_end_at: z.iso.datetime().nullable(),
    reservations_reset: z.number().int().min(0),
  }),
});

export type ClassifyMaterialityBody = z.infer<typeof classifyMaterialityBodySchema>;
export type ClassifyMaterialityResponse = z.infer<typeof classifyMaterialityResponseSchema>;

import { z } from "zod";

import { ownedCaseSchema } from "./origination.schemas.js";

// Extends ownedCaseSchema (the same shape the owner-applicant and founder
// surfaces already return) with the post-IPO formalization fields
// (CORE_TABLES.md) -- deliberately nothing else, so a partner never sees
// founder-only fields like founder_review_notes/ipo_value_eur/applicant
// identity (PERMISSION_MATRIX.md's Protected Case Areas). Both partner
// roles read both workstreams; only the write side is per-role-restricted.
export const partnerCaseSchema = ownedCaseSchema.extend({
  legal_document_refs: z.array(z.string()),
  legal_structuring_completed_at: z.iso.datetime().nullable(),
  appraisal_value_opinion_eur: z.string().regex(/^\d+\.\d{2}$/).nullable(),
  appraisal_document_refs: z.array(z.string()),
  appraisal_completed_at: z.iso.datetime().nullable(),
  post_ipo_structuring_completed_at: z.iso.datetime().nullable(),
});

export const partnerCaseListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).optional(),
});

export const partnerCaseListResponseSchema = z.object({
  data: z.array(partnerCaseSchema),
  page: z.object({ next_cursor: z.string().nullable() }),
});

export const partnerCaseDetailResponseSchema = z.object({ data: partnerCaseSchema });

export const recordLegalStructuringBodySchema = z
  .object({
    legal_document_refs: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
    // A one-way switch, not a boolean toggle: sending anything other than
    // true (including false) is rejected rather than silently ignored,
    // since there is no "uncomplete" (PERMISSION_MATRIX.md's formalization
    // work "cannot block or unwind a case").
    mark_completed: z.literal(true).optional(),
  })
  .refine(
    (value) => value.legal_document_refs !== undefined || value.mark_completed !== undefined,
    { message: "At least one of legal_document_refs or mark_completed is required." },
  );

export const recordLegalStructuringResponseSchema = z.object({ data: partnerCaseSchema });

export const recordAppraisalBodySchema = z
  .object({
    appraisal_value_opinion_eur: z
      .string()
      .regex(/^\d{1,13}\.\d{2}$/)
      // The regex check above doesn't short-circuit this one in zod v4 --
      // both checks always run -- so this must independently guard against
      // a non-numeric string before calling BigInt, which throws a raw
      // SyntaxError (not a ZodError) on invalid input otherwise.
      .refine(
        (value) => /^\d+$/.test(value.replace(".", "")) && BigInt(value.replace(".", "")) > 0n,
        "Appraisal value must be positive.",
      )
      .optional(),
    appraisal_document_refs: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
    mark_completed: z.literal(true).optional(),
  })
  .refine(
    (value) =>
      value.appraisal_value_opinion_eur !== undefined ||
      value.appraisal_document_refs !== undefined ||
      value.mark_completed !== undefined,
    {
      message:
        "At least one of appraisal_value_opinion_eur, appraisal_document_refs, or mark_completed is required.",
    },
  );

export const recordAppraisalResponseSchema = z.object({ data: partnerCaseSchema });

export type PartnerCaseResponse = z.infer<typeof partnerCaseSchema>;
export type PartnerCaseListQuery = z.infer<typeof partnerCaseListQuerySchema>;
export type RecordLegalStructuringBody = z.infer<typeof recordLegalStructuringBodySchema>;
export type RecordAppraisalBody = z.infer<typeof recordAppraisalBodySchema>;

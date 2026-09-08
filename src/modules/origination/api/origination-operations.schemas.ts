import { z } from "zod";

import { originationCaseStageSchema, ownedCaseSchema } from "./origination.schemas.js";

// The two human-postable lanes REAL_ESTATE_INTAKE_LIFECYCLE.md's Thread
// Rules define (system_timeline is system-generated, not a lane a caller
// selects). The owner-facing routes never take a lane at all — the
// applicant has exactly one lane to reach and it's hardcoded there.
const threadLaneSchema = z.enum(["internal_case", "applicant"]);

export const listCaseMessagesQuerySchema = z.object({
  lane: threadLaneSchema,
});

export const postOperationsCaseMessageBodySchema = z.object({
  lane: threadLaneSchema,
  body: z.string().trim().min(1).max(5000),
});

export const operationsCaseListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).optional(),
  stage: originationCaseStageSchema.optional(),
});

export const operationsCaseListResponseSchema = z.object({
  data: z.array(ownedCaseSchema),
  page: z.object({ next_cursor: z.string().nullable() }),
});

const operationsInformationRequestSchema = z.object({
  request_id: z.string(),
  status: z.enum(["proposed", "published", "answered", "withdrawn", "expired"]),
  request_body: z.string(),
  published_at: z.iso.datetime().nullable(),
  due_at: z.iso.datetime().nullable(),
  resolved_at: z.iso.datetime().nullable(),
  resolution_type: z.enum(["resubmitted", "withdrawn", "expired"]).nullable(),
  resolving_revision_id: z.string().nullable(),
});

export const operationsCaseDetailResponseSchema = z.object({
  data: ownedCaseSchema.extend({
    applicant_account_id: z.string(),
    founder_review: z.object({
      notes: z.string().nullable(),
      reviewed_by_account_id: z.string().nullable(),
      approved_at: z.iso.datetime().nullable(),
      rejected_at: z.iso.datetime().nullable(),
      rejection_reason_code: z.string().nullable(),
      rejection_notes: z.string().nullable(),
      ipo_period_days: z.number().int().positive().nullable(),
      ipo_end_at: z.iso.datetime().nullable(),
      ipo_value_eur: z.string().regex(/^\d+\.\d{2}$/).nullable(),
    }),
    submission: z
      .object({
        revision_id: z.string(),
        revision_number: z.number().int().positive(),
        submitted_at: z.iso.datetime(),
        submitted_by_account_id: z.string(),
        submission_data: z.json(),
        evidence: z.array(
          z.object({
            evidence_id: z.string(),
            document_type: z.string(),
            status: z.string(),
            document_ref: z.string(),
            extract_dated: z.iso.datetime().nullable(),
            uploaded_at: z.iso.datetime(),
          }),
        ),
      })
      .nullable(),
    information_requests: z.array(operationsInformationRequestSchema),
  }),
});

export const publishInformationRequestBodySchema = z.object({
  request_body: z.string().trim().min(1).max(5000),
});

export const publishInformationRequestResponseSchema = z.object({
  data: z.object({
    request_id: z.string(),
    case_id: z.string(),
    status: z.literal("published"),
    request_body: z.string(),
    published_at: z.iso.datetime(),
    due_at: z.iso.datetime(),
  }),
});

export const founderDecisionBodySchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    founder_review_notes: z.string().trim().min(1).max(10000),
    ipo_period_days: z.number().int().min(1).max(365),
    ipo_value_eur: z
      .string()
      .regex(/^\d{1,13}\.\d{2}$/)
      // The regex check above doesn't short-circuit this one in zod v4 --
      // both checks always run -- so this must independently guard against
      // a non-numeric string before calling BigInt, which throws a raw
      // SyntaxError (not a ZodError) on invalid input otherwise.
      .refine(
        (value) => /^\d+$/.test(value.replace(".", "")) && BigInt(value.replace(".", "")) > 0n,
        "IPO value must be positive.",
      ),
  }),
  z.object({
    decision: z.literal("reject"),
    founder_review_notes: z.string().trim().min(1).max(10000),
    rejection_reason_code: z.string().trim().min(1).max(100),
    rejection_notes: z.string().trim().min(1).max(5000),
  }),
]);

export const founderDecisionResponseSchema = z.object({
  data: z.object({
    case_id: z.string(),
    stage: z.enum(["pre_offering_open", "rejected"]),
    decided_at: z.iso.datetime(),
    ipo_end_at: z.iso.datetime().nullable(),
  }),
});

// Distinct from founderDecisionBodySchema above: that's the submitted-stage
// initial review (approve/reject); this is the later, broader closure
// PERMISSION_MATRIX.md lists separately ("Reject, withdraw, or expire a
// case, at any stage"). reasonCode/notes only apply to a late-stage reject,
// matching REAL_ESTATE_INTAKE_LIFECYCLE.md's "keep an auditable reason
// category and notes" rule for Rejected specifically.
export const closeCaseBodySchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("withdrawn"),
    founder_review_notes: z.string().trim().min(1).max(10000),
  }),
  z.object({
    outcome: z.literal("rejected"),
    founder_review_notes: z.string().trim().min(1).max(10000),
    rejection_reason_code: z.string().trim().min(1).max(100),
    rejection_notes: z.string().trim().min(1).max(5000),
  }),
]);

export const closeCaseResponseSchema = z.object({
  data: z.object({
    case_id: z.string(),
    stage: z.enum(["withdrawn", "rejected"]),
    closed_at: z.iso.datetime(),
  }),
});

export const assignPartnerOrganizationBodySchema = z
  .object({
    legal_practice_id: z.string().trim().min(1).optional(),
    appraisal_firm_id: z.string().trim().min(1).optional(),
  })
  .refine(
    (value) => value.legal_practice_id !== undefined || value.appraisal_firm_id !== undefined,
    { message: "At least one of legal_practice_id or appraisal_firm_id is required." },
  );

export const assignPartnerOrganizationResponseSchema = z.object({
  data: z.object({
    case_id: z.string(),
    legal_practice_id: z.string().nullable(),
    appraisal_firm_id: z.string().nullable(),
  }),
});

export type OperationsCaseListQuery = z.infer<typeof operationsCaseListQuerySchema>;
export type PublishInformationRequestBody = z.infer<typeof publishInformationRequestBodySchema>;
export type FounderDecisionBody = z.infer<typeof founderDecisionBodySchema>;
export type CloseCaseBody = z.infer<typeof closeCaseBodySchema>;
export type AssignPartnerOrganizationBody = z.infer<typeof assignPartnerOrganizationBodySchema>;
export type ListCaseMessagesQuery = z.infer<typeof listCaseMessagesQuerySchema>;
export type PostOperationsCaseMessageBody = z.infer<typeof postOperationsCaseMessageBodySchema>;

import { z } from "zod";

export const createDraftIntakeBodySchema = z.object({
  intake_terms_accepted: z.literal(true),
  one_title_confirmed: z.literal(true),
  property: z.object({
    property_type: z.literal("residential"),
    country_code: z.string().length(2).transform((value) => value.toUpperCase()),
    city: z.string().trim().min(1).max(200).nullable().default(null),
    address_line: z.string().trim().min(1).max(500).nullable().default(null),
    land_registry_reference: z.string().trim().min(1).max(200).nullable().default(null),
    latitude: z.number().min(-90).max(90).nullable().default(null),
    longitude: z.number().min(-180).max(180).nullable().default(null),
    owner_declared_value_eur: z.string().regex(/^\d{1,13}\.\d{2}$/),
    has_existing_encumbrance: z.boolean().default(false),
  }),
});

export const createDraftIntakeResponseSchema = z.object({
  data: z.object({
    case_id: z.string(),
    property_id: z.string(),
    stage: z.literal("draft"),
  }),
});

export type CreateDraftIntakeBody = z.infer<typeof createDraftIntakeBodySchema>;
export type CreateDraftIntakeResponse = z.infer<typeof createDraftIntakeResponseSchema>;

export const originationCaseStageSchema = z.enum([
  "draft",
  "submitted",
  "waiting_on_applicant",
  "pre_offering_open",
  "post_ipo_structuring",
  "approved_for_final_offering",
  "rejected",
  "withdrawn",
  "expired",
]);

export const listOwnCasesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).optional(),
});

export const caseIdParamsSchema = z.object({
  case_id: z.string().min(1),
});

export const informationRequestParamsSchema = z.object({
  case_id: z.string().min(1),
  request_id: z.string().min(1),
});

export const ownedCaseSchema = z.object({
  case_id: z.string(),
  stage: originationCaseStageSchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  current_revision: z
    .object({ revision_number: z.number().int().positive(), submitted_at: z.iso.datetime() })
    .nullable(),
  property: z.object({
    property_id: z.string(),
    property_type: z.literal("residential"),
    country_code: z.string().length(2),
    city: z.string().nullable(),
    address_line: z.string().nullable(),
    land_registry_reference: z.string().nullable(),
    owner_declared_value_eur: z.string().regex(/^\d+\.\d{2}$/),
    has_existing_encumbrance: z.boolean(),
  }),
});

export const listOwnCasesResponseSchema = z.object({
  data: z.array(ownedCaseSchema),
  page: z.object({ next_cursor: z.string().nullable() }),
});

export const getOwnCaseResponseSchema = z.object({ data: ownedCaseSchema });

export const submissionDocumentTypeSchema = z.enum([
  "ownership_declaration",
  "property_facts_sheet",
  "encumbrance_declaration",
  "photo_set",
  "registry_extract",
  "title_instrument",
  "cadastral_map",
  "power_of_attorney",
  "name_change_evidence",
  "occupancy_evidence",
  "succession_evidence",
]);

export const submitInitialCaseBodySchema = z.object({
  intake_terms_accepted: z.literal(true),
  one_title_confirmed: z.literal(true),
  submission_data: z
    .record(z.string(), z.json())
    .refine((value) => Object.keys(value).length > 0, "Submission data must not be empty."),
  documents: z
    .array(
      z.object({
        document_type: submissionDocumentTypeSchema,
        document_ref: z.string().trim().min(1).max(500),
        extract_dated: z.iso.datetime().nullable().default(null),
      }),
    )
    .min(1)
    .max(50),
});

export const submitInitialCaseResponseSchema = z.object({
  data: z.object({
    case_id: z.string(),
    revision_id: z.string(),
    revision_number: z.literal(1),
    stage: z.literal("submitted"),
    submitted_at: z.iso.datetime(),
  }),
});

export const informationRequestSchema = z.object({
  request_id: z.string(),
  case_id: z.string(),
  status: z.enum(["published", "answered", "withdrawn", "expired"]),
  request_body: z.string(),
  published_at: z.iso.datetime(),
  due_at: z.iso.datetime(),
  resolved_at: z.iso.datetime().nullable(),
  resolution_type: z.enum(["resubmitted", "withdrawn", "expired"]).nullable(),
  resolving_revision_id: z.string().nullable(),
});

export const listInformationRequestsResponseSchema = z.object({
  data: z.array(informationRequestSchema),
});

export const resubmitCaseResponseSchema = z.object({
  data: z.object({
    case_id: z.string(),
    revision_id: z.string(),
    revision_number: z.number().int().min(2),
    stage: z.literal("submitted"),
    submitted_at: z.iso.datetime(),
    resolved_request_id: z.string(),
  }),
});

export type ListOwnCasesQuery = z.infer<typeof listOwnCasesQuerySchema>;
export type OwnedCaseResponse = z.infer<typeof ownedCaseSchema>;
export type SubmitInitialCaseBody = z.infer<typeof submitInitialCaseBodySchema>;

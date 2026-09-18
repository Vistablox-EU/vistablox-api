import { z } from "zod";

// Shared across the input (createDraftIntakeBodySchema, staff
// createStaffCaseBodySchema) and output (ownedCaseSchema) property shapes
// below, so all three stay in lockstep. property_type itself stays
// z.literal("residential") -- locked by AD-081/properties_residential_only,
// unrelated to and unchanged by residentialSubtypeSchema here.
export const residentialSubtypeSchema = z.enum([
  "apartment",
  "house",
  "townhouse",
  "multi_family",
  "studio",
  "other",
]);

export const propertyConditionSchema = z.enum([
  "new",
  "renovated",
  "good",
  "fair",
  "needs_renovation",
]);

// Standard EU EPC scale.
export const energyRatingSchema = z.enum(["A+", "A", "B", "C", "D", "E", "F", "G"]);

export const roomTypeSchema = z.enum([
  "bedroom",
  "bathroom",
  "kitchen",
  "living_room",
  "dining_room",
  "office",
  "storage",
  "other",
]);

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
    residential_subtype: residentialSubtypeSchema.nullable().default(null),
    living_area_sq_m: z.number().positive().max(9999.99).nullable().default(null),
    bedrooms: z.number().int().min(0).nullable().default(null),
    bathrooms: z.number().int().min(0).nullable().default(null),
    floor: z.number().int().min(-5).nullable().default(null),
    total_floors: z.number().int().min(1).nullable().default(null),
    year_built: z.number().int().min(1800).max(2100).nullable().default(null),
    condition: propertyConditionSchema.nullable().default(null),
    energy_rating: energyRatingSchema.nullable().default(null),
    // .default([]), not .min(1): this is a live customer endpoint, and a
    // non-defaulted required array would 400 every existing caller.
    rooms: z
      .array(
        z.object({
          room_type: roomTypeSchema,
          size_sq_m: z.number().positive().max(9999.99),
        }),
      )
      .max(30)
      .default([]),
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

export const intakeCaseStageSchema = z.enum([
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
  stage: intakeCaseStageSchema,
  stage_label: z.string(),
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
      residential_subtype: residentialSubtypeSchema.nullable(),
      residential_subtype_label: z.string().nullable(),
    living_area_sq_m: z.number().nullable(),
    bedrooms: z.number().int().nullable(),
    bathrooms: z.number().int().nullable(),
    floor: z.number().int().nullable(),
    total_floors: z.number().int().nullable(),
    year_built: z.number().int().nullable(),
      condition: propertyConditionSchema.nullable(),
      condition_label: z.string().nullable(),
    energy_rating: energyRatingSchema.nullable(),
    energy_rating_label: z.string().nullable(),
      rooms: z.array(
        z.object({
          room_id: z.string(),
          room_type: roomTypeSchema,
          room_type_label: z.string(),
        size_sq_m: z.number(),
        preferred_photo_id: z.string().nullable(),
        representative_photo_id: z.string().nullable(),
        photos: z.array(z.object({
          document_id: z.string(),
          document_ref: z.string(),
          thumbnail_ref: z.string().nullable(),
          content_type: z.string(),
          uploaded_at: z.iso.datetime(),
        })),
      }),
    ),
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
  status_label: z.string(),
  request_body: z.string(),
  published_at: z.iso.datetime(),
  due_at: z.iso.datetime(),
  resolved_at: z.iso.datetime().nullable(),
  resolution_type: z.enum(["resubmitted", "withdrawn", "expired"]).nullable(),
  resolution_type_label: z.string().nullable(),
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

// Shared by both the owner-facing (always the applicant lane) and
// operations-facing (either lane) message routes.
export const caseMessageSchema = z.object({
  message_id: z.string(),
  author_account_id: z.string().nullable(),
  body: z.string(),
  created_at: z.iso.datetime(),
});

export const listCaseMessagesResponseSchema = z.object({
  data: z.array(caseMessageSchema),
});

export const postCaseMessageBodySchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

export const postCaseMessageResponseSchema = z.object({
  data: caseMessageSchema,
});

export type ListOwnCasesQuery = z.infer<typeof listOwnCasesQuerySchema>;
export type OwnedCaseResponse = z.infer<typeof ownedCaseSchema>;
export type SubmitInitialCaseBody = z.infer<typeof submitInitialCaseBodySchema>;

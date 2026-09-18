import { z } from "zod";

import {
  energyRatingSchema,
  intakeCaseStageSchema,
  ownedCaseSchema,
  propertyConditionSchema,
  residentialSubtypeSchema,
  roomTypeSchema,
  submissionDocumentTypeSchema,
} from "./intake.schemas.js";
import { reversalCommandSchema, reversalReasonCodeSchema } from "../domain/intake-reversal.policy.js";

// The two human-postable lanes REAL_ESTATE_INTAKE_LIFECYCLE.md's Thread
// Rules define (system_timeline is system-generated, not a lane a caller
// selects). The owner-facing routes never take a lane at all — the
// applicant has exactly one lane to reach and it's hardcoded there.
const threadLaneSchema = z.enum(["internal_case", "applicant"]);

export const listCaseMessagesQuerySchema = z.object({
  lane: threadLaneSchema,
});

export const evidenceReviewParamsSchema = z.object({
  case_id: z.string().min(1),
  evidence_id: z.string().min(1),
});

export const roomPhotoParamsSchema = z.object({
  case_id: z.string().trim().min(1),
  room_id: z.string().trim().min(1),
  document_id: z.string().trim().min(1),
});

export const roomParamsSchema = roomPhotoParamsSchema.omit({ document_id: true });

export const setRepresentativePhotoBodySchema = z.object({
  document_id: z.string().trim().min(1),
});

export const deleteRoomPhotoBodySchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
}).default({});

export const reversalCommandParamsSchema = z.object({ case_id: z.string().trim().min(1) });
export const reversalOperationParamsSchema = z.object({ case_id: z.string().trim().min(1), operation_id: z.string().trim().min(1) });
export const reversalRequestBodySchema = z.object({ reason_code: reversalReasonCodeSchema, reason: z.string().trim().min(1).max(500) });
export const reversalCommandSchemaForApi = reversalCommandSchema;
export const reversalPreviewResponseSchema = z.object({
  data: z.object({
    case_id: z.string(), stage: intakeCaseStageSchema, workflow_event_sequence: z.number().int().nonnegative(),
    latest_transition: z.object({ event_id: z.string(), from_stage: intakeCaseStageSchema, to_stage: intakeCaseStageSchema }).nullable(),
    correction_in_progress: z.boolean(), available: z.boolean(),
    actions: z.array(z.object({ action: reversalCommandSchema, label: z.string(), target_stage: intakeCaseStageSchema, requires_reason: z.boolean(), requires_second_approval: z.boolean(), execution_mode: z.enum(["synchronous", "asynchronous"]), impact_summary: z.string(), blockers: z.array(z.string()) })),
  }),
});
export const reversalOperationResponseSchema = z.object({ data: z.object({ operation_id: z.string(), case_id: z.string(), command: reversalCommandSchema, from_stage: intakeCaseStageSchema, to_stage: intakeCaseStageSchema, status: z.enum(["requested", "pending_approval", "approved", "executing", "completed", "failed", "cancelled"]), reason_code: reversalReasonCodeSchema, requested_by_account_id: z.string(), approved_by_account_id: z.string().nullable(), reversal_of_event_id: z.string().nullable(), completed_at: z.iso.datetime().nullable(), failed_at: z.iso.datetime().nullable(), failure_code: z.string().nullable(), failure_detail: z.string().nullable() }) });

export const postOperationsCaseMessageBodySchema = z.object({
  lane: threadLaneSchema,
  body: z.string().trim().min(1).max(5000),
});

// Staff create-and-submit: the applicant is picked via GET
// /internal/v1/accounts?email=, staff attests eligibility out-of-band (no
// self-KYC/proof-of-address gate here), and the case goes straight to
// "submitted" in one action -- same shape as the owner-facing
// createDraftIntakeBodySchema + submitInitialCaseBodySchema combined, plus
// the new applicant_account_id field neither of those has.
export const createStaffCaseBodySchema = z.object({
  applicant_account_id: z.string().min(1),
  intake_terms_accepted: z.literal(true),
  one_title_confirmed: z.literal(true),
  property: z.object({
    property_type: z.literal("residential"),
    country_code: z
      .string()
      .length(2)
      .transform((value) => value.toUpperCase()),
    city: z.string().trim().min(1).max(200).nullable().default(null),
    address_line: z.string().trim().min(1).max(500).nullable().default(null),
    land_registry_reference: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .nullable()
      .default(null),
    owner_declared_value_eur: z.string().regex(/^\d{1,13}\.\d{2}$/),
    has_existing_encumbrance: z.boolean().default(false),
    residential_subtype: residentialSubtypeSchema.nullable().default(null),
    living_area_sq_m: z
      .number()
      .positive()
      .max(9999.99)
      .nullable()
      .default(null),
    bedrooms: z.number().int().min(0).nullable().default(null),
    bathrooms: z.number().int().min(0).nullable().default(null),
    floor: z.number().int().min(-5).nullable().default(null),
    total_floors: z.number().int().min(1).nullable().default(null),
    year_built: z.number().int().min(1800).max(2100).nullable().default(null),
    condition: propertyConditionSchema.nullable().default(null),
    energy_rating: energyRatingSchema.nullable().default(null),
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

export const createStaffCaseResponseSchema = z.object({
  data: z.object({
    case_id: z.string(),
    revision_id: z.string(),
    revision_number: z.literal(1),
    stage: z.literal("submitted"),
    submitted_at: z.iso.datetime(),
    applicant_account_id: z.string(),
  }),
});
export const createStaffDraftCaseBodySchema = createStaffCaseBodySchema.omit({ documents: true });
export const createStaffDraftCaseResponseSchema = z.object({
  data: z.object({ case_id: z.string(), property_id: z.string(), stage: z.literal("draft"), applicant_account_id: z.string() }),
});
export const createStaffDraftSubmitBodySchema = z.object({
  intake_terms_accepted: z.literal(true), one_title_confirmed: z.literal(true),
  submission_data: z.record(z.string(), z.json()).refine((v) => Object.keys(v).length > 0),
  documents: z.array(z.object({ document_type: submissionDocumentTypeSchema, document_ref: z.string().trim().min(1).max(500), extract_dated: z.iso.datetime().nullable().default(null) })).min(1).max(50),
});
export type CreateStaffDraftSubmitBody = z.infer<typeof createStaffDraftSubmitBodySchema>;

export const operationsCaseListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).optional(),
  stage: intakeCaseStageSchema.optional(),
});

export const operationsCaseListResponseSchema = z.object({
  data: z.array(ownedCaseSchema),
  page: z.object({ next_cursor: z.string().nullable() }),
});

const workflowTypeSchema = z.enum([
  "draft_submission", "operations_review", "applicant_information", "ipo",
  "post_ipo_structuring", "final_offering", "terminal",
]);
const workflowStageSchema = intakeCaseStageSchema;

export const intakeWorkflowResponseSchema = z.object({
  data: z.object({
    case_id: z.string(),
    stage: workflowStageSchema,
    stage_label: z.string(),
    workflow_type: workflowTypeSchema,
    workflow_version: z.number().int().positive(),
    terminal: z.boolean(),
    stage_sequence: z.array(z.object({ stage: workflowStageSchema, label: z.string() })),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    workflow: z.object({
      current_revision_number: z.number().int().positive().nullable(),
      active_information_request: z.object({
        request_id: z.string(),
        status: z.string(),
        published_at: z.iso.datetime().nullable(),
        due_at: z.iso.datetime().nullable(),
      }).nullable(),
      information_request_count: z.number().int().nonnegative(),
      workflow_type: workflowTypeSchema,
    }).passthrough(),
    allowed_actions: z.array(z.string()),
    allowed_action_labels: z.array(z.string()),
    blockers: z.array(z.object({ code: z.string(), severity: z.enum(["blocking", "warning"]), blocks_actions: z.array(z.string()), message: z.string(), metadata: z.record(z.string(), z.unknown()).optional() })),
  }),
});

export const intakeHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().min(1).optional(),
});

export const intakeCaseHistoryResponseSchema = z.object({
  data: z.array(z.object({
    event_id: z.string(),
    event_sequence: z.number().int().positive(),
    event_type: z.string(),
    event_label: z.string(),
    workflow_type: workflowTypeSchema,
    workflow_version: z.number().int().nonnegative(),
    occurred_at: z.iso.datetime(),
    actor: z.object({ type: z.string(), account_id: z.string().nullable() }),
    stage_transition: z.object({ from: intakeCaseStageSchema, from_label: z.string(), to: intakeCaseStageSchema, to_label: z.string() }).nullable(),
    related_resource: z.object({ type: z.string(), id: z.string() }).nullable(),
    source: z.enum(["live", "legacy_audit"]),
    details: z.unknown(),
  })),
  page: z.object({ next_cursor: z.string().nullable() }),
});

const operationsInformationRequestSchema = z.object({
  request_id: z.string(),
  status: z.enum(["proposed", "published", "answered", "withdrawn", "expired"]),
  status_label: z.string(),
  request_body: z.string(),
  published_at: z.iso.datetime().nullable(),
  due_at: z.iso.datetime().nullable(),
  resolved_at: z.iso.datetime().nullable(),
  resolution_type: z.enum(["resubmitted", "withdrawn", "expired"]).nullable(),
  resolution_type_label: z.string().nullable(),
  resolving_revision_id: z.string().nullable(),
});

// The full evidence review vocabulary the documentary_screening_evidence_
// status_check CHECK constraint already fixes (added in
// 20260831170000_intake_review_workflow, unchanged since): "pending" is
// the only value that arrives without a review ever having happened.
const evidenceStatusSchema = z.enum([
  "pending",
  "mandatory_missing",
  "accepted",
  "rejected",
]);

export const operationsReadinessResponseSchema = z.object({
  data: z.object({
    case_id: z.string(),
    evaluated_at: z.iso.datetime(),
    stage: intakeCaseStageSchema,
    stage_label: z.string(),
    linked_offering: z
      .object({
        offering_id: z.string(),
        status: z.string(),
        status_label: z.string(),
        minimum_raise_eur: z.string().regex(/^\d+\.\d{2}$/),
        target_raise_eur: z.string().regex(/^\d+\.\d{2}$/),
        final_offering_published_at: z.iso.datetime().nullable(),
        platform_rights_end_at: z.iso.datetime().nullable(),
        effective_rights_end_at: z.iso.datetime().nullable(),
        ipo_end_at: z.iso.datetime().nullable(),
      })
      .nullable(),
    evidence: z.object({
      submission_present: z.boolean(),
      revision_number: z.number().int().nullable(),
      required_document_types: z.array(z.string()),
      required_document_type_labels: z.array(z.string()),
      present_document_types: z.array(z.string()),
      present_document_type_labels: z.array(z.string()),
      missing_document_types: z.array(z.string()),
      missing_document_type_labels: z.array(z.string()),
      accepted_count: z.number().int(),
      pending_count: z.number().int(),
      rejected_count: z.number().int(),
      mandatory_missing_count: z.number().int(),
      complete: z.boolean(),
      rejected_documents: z.array(z.string()),
      rejected_document_labels: z.array(z.string()),
    }),
    partner_assignments: z.object({
      legal_practice_id: z.string().nullable(),
      legal_structuring_completed_at: z.iso.datetime().nullable(),
      appraisal_firm_id: z.string().nullable(),
      appraisal_completed_at: z.iso.datetime().nullable(),
      assignment_complete: z.boolean(),
      structuring_complete: z.boolean(),
    }),
    founder_decision: z.object({
      status: z.enum(["pending", "approved", "rejected"]),
      status_label: z.string(),
      reviewed_by_account_id: z.string().nullable(),
      approved_at: z.iso.datetime().nullable(),
      rejected_at: z.iso.datetime().nullable(),
      ipo_period_days: z.number().int().nullable(),
      ipo_value_eur: z
        .string()
        .regex(/^\d+\.\d{2}$/)
        .nullable(),
      ipo_end_at: z.iso.datetime().nullable(),
    }),
    disclosure_pack: z
      .object({
        current_pack_id: z.string(),
        version: z.number().int(),
        published_at: z.iso.datetime(),
        present_document_types: z.array(z.string()),
        present_document_type_labels: z.array(z.string()),
        missing_document_types: z.array(z.string()),
        missing_document_type_labels: z.array(z.string()),
        complete: z.boolean(),
      })
      .nullable(),
    funding: z
      .object({
        target_raise_eur: z.string().regex(/^\d+\.\d{2}$/),
        reserved_eur: z.string().regex(/^\d+\.\d{2}$/),
        funded_eur: z.string().regex(/^\d+\.\d{2}$/),
        remaining_eur: z.string().regex(/^\d+\.\d{2}$/),
        funded_percent: z.number().min(0).max(100),
        reservation_counts: z.object({
          initiated: z.number().int(),
          awaiting_reconfirmation: z.number().int(),
          reconfirmed: z.number().int(),
          finalized: z.number().int(),
          cancelled: z.number().int(),
          lapsed: z.number().int(),
        }),
        reservation_stage_labels: z.record(z.string(), z.string()),
        funded_reservation_count: z.number().int(),
      })
      .nullable(),
    allowed_next_actions: z.array(
      z.enum([
        "review_evidence",
        "request_information",
        "record_founder_decision",
        "assign_partner",
        "publish_disclosure_pack",
        "publish_final_offering_terms",
        "retry_post_ipo_handoff",
        "close_case",
      ]),
    ),
    allowed_next_action_labels: z.array(z.string()),
    blockers: z.array(
      z.object({
        code: z.enum([
          "case_terminal",
          "submission_missing",
          "evidence_missing",
          "evidence_pending_review",
          "evidence_rejected",
          "evidence_mandatory_missing",
          "founder_decision_missing",
          "partner_assignment_missing",
          "legal_structuring_incomplete",
          "appraisal_incomplete",
          "offering_missing",
          "disclosure_pack_missing",
          "disclosure_pack_incomplete",
          "funding_target_not_reached",
          "offering_final_terms_already_published",
          "ipo_period_expired",
          "post_ipo_handoff_pending",
        ]),
        code_label: z.string(),
        severity: z.enum(["blocking", "warning"]),
        severity_label: z.string(),
        blocks_actions: z.array(
          z.enum([
            "review_evidence",
            "request_information",
            "record_founder_decision",
            "assign_partner",
            "publish_disclosure_pack",
            "publish_final_offering_terms",
            "retry_post_ipo_handoff",
            "close_case",
          ]),
        ),
        blocks_action_labels: z.array(z.string()),
        message: z.string(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
  }),
});

export const operationsCaseDetailResponseSchema = z.object({
  data: ownedCaseSchema.extend({
    applicant_account_id: z.string(),
    applicant: z.object({
      account_id: z.string(),
      display_name: z.string().nullable(),
      given_name: z.string().nullable(),
      family_name: z.string().nullable(),
      id_document_country_code: z.string().regex(/^[A-Z]{2}$/).nullable(),
      identity_available: z.boolean(),
      profile_synced_at: z.iso.datetime().nullable(),
    }),
    legal_practice_id: z.string().nullable(),
    appraisal_firm_id: z.string().nullable(),
    // The case's PIV's most recent Offering (null until the post-approval
    // intake-to-offering handoff has opened one). Lets the staff
    // detail view surface a stuck post-IPO-structuring handoff: a case at
    // pre_offering_open whose offering already has
    // final_offering_published_at set means the automatic job should have
    // fired but didn't.
    offering: z
      .object({
        offering_id: z.string(),
        status: z.string(),
        status_label: z.string(),
        final_offering_published_at: z.iso.datetime().nullable(),
      })
      .nullable(),
    founder_review: z.object({
      notes: z.string().nullable(),
      reviewed_by_account_id: z.string().nullable(),
      approved_at: z.iso.datetime().nullable(),
      rejected_at: z.iso.datetime().nullable(),
      rejection_reason_code: z.string().nullable(),
      rejection_notes: z.string().nullable(),
      ipo_period_days: z.number().int().positive().nullable(),
      ipo_end_at: z.iso.datetime().nullable(),
      ipo_value_eur: z
        .string()
        .regex(/^\d+\.\d{2}$/)
        .nullable(),
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
            document_type_label: z.string(),
            status: evidenceStatusSchema,
            status_label: z.string(),
            document_ref: z.string(),
            extract_dated: z.iso.datetime().nullable(),
            uploaded_at: z.iso.datetime(),
            reviewed_by_account_id: z.string().nullable(),
            reviewed_at: z.iso.datetime().nullable(),
            review_notes: z.string().nullable(),
          }),
        ),
      })
      .nullable(),
    information_requests: z.array(operationsInformationRequestSchema),
  }),
});

// This is purely advisory: nothing today reads evidence status for any
// decision (canRecordFounderDecision included), and this endpoint doesn't
// change that -- it only lets staff record what they found. No case-stage
// restriction either, by the same design call: reviewable at any stage.
export const reviewEvidenceBodySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    review_notes: z.string().trim().max(2000).nullable().default(null),
  }),
  z.object({
    status: z.literal("rejected"),
    review_notes: z.string().trim().min(1).max(2000),
  }),
  z.object({
    status: z.literal("mandatory_missing"),
    review_notes: z.string().trim().min(1).max(2000),
  }),
]);

export const reviewEvidenceResponseSchema = z.object({
  data: z.object({
    evidence_id: z.string(),
    case_id: z.string(),
    status: z.enum(["accepted", "rejected", "mandatory_missing"]),
    reviewed_by_account_id: z.string(),
    reviewed_at: z.iso.datetime(),
    review_notes: z.string().nullable(),
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

// Manual staff overrides for a single published information request --
// the always-available complement to the scheduled batch jobs in
// case-timer.service.ts. Force-expire requires a typed reason (surfaced in
// the audit log's changes payload); the frontend shows an explicit
// "cannot be undone" warning before the staff user confirms, which is why
// the reason is required here rather than optional.
export const forceExpireInformationRequestBodySchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});

export const forceExpireInformationRequestResponseSchema = z.object({
  data: z.object({
    request_id: z.string(),
    case_id: z.string(),
    status: z.literal("expired"),
  }),
});

// No request body: the manual reminder is a fire-and-forget email send with
// no persisted "sent" marker, matching SendApplicantResponseRemindersService's
// own lack of one -- so there is nothing to record beyond confirming it ran.
export const sendManualReminderResponseSchema = z.object({
  data: z.object({
    request_id: z.string(),
    case_id: z.string(),
    sent: z.literal(true),
  }),
});

export const withdrawInformationRequestBodySchema = z.object({
  founder_review_notes: z
    .string()
    .trim()
    .min(1)
    .max(5000)
    .nullable()
    .default(null),
});

export const withdrawInformationRequestResponseSchema = z.object({
  data: z.object({
    request_id: z.string(),
    case_id: z.string(),
    status: z.literal("withdrawn"),
    resolved_at: z.iso.datetime(),
    stage: z.literal("submitted"),
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
        (value) =>
          /^\d+$/.test(value.replace(".", "")) &&
          BigInt(value.replace(".", "")) > 0n,
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
    (value) =>
      value.legal_practice_id !== undefined ||
      value.appraisal_firm_id !== undefined,
    {
      message:
        "At least one of legal_practice_id or appraisal_firm_id is required.",
    },
  );

export const assignPartnerOrganizationResponseSchema = z.object({
  data: z.object({
    case_id: z.string(),
    legal_practice_id: z.string().nullable(),
    appraisal_firm_id: z.string().nullable(),
  }),
});

// Manual staff retry for the post-approval intake-to-offering handoff
// (AD-145/AD-152), for the rare case where the automatic pg-boss job
// dead-lettered or otherwise never ran. Mirrors
// TransitionedToPostIpoStructuring's own stage union rather than a bare
// string, since those are the only two reachable outcomes.
export const retryPostIpoStructuringHandoffResponseSchema = z.object({
  data: z.object({
    case_id: z.string(),
    stage: z.enum(["post_ipo_structuring", "approved_for_final_offering"]),
  }),
});

export type CreateStaffCaseBody = z.infer<typeof createStaffCaseBodySchema>;
export type OperationsCaseListQuery = z.infer<
  typeof operationsCaseListQuerySchema
>;
export type PublishInformationRequestBody = z.infer<
  typeof publishInformationRequestBodySchema
>;
export type ForceExpireInformationRequestBody = z.infer<
  typeof forceExpireInformationRequestBodySchema
>;
export type WithdrawInformationRequestBody = z.infer<
  typeof withdrawInformationRequestBodySchema
>;
export type FounderDecisionBody = z.infer<typeof founderDecisionBodySchema>;
export type CloseCaseBody = z.infer<typeof closeCaseBodySchema>;
export type AssignPartnerOrganizationBody = z.infer<
  typeof assignPartnerOrganizationBodySchema
>;
export type ListCaseMessagesQuery = z.infer<typeof listCaseMessagesQuerySchema>;
export type PostOperationsCaseMessageBody = z.infer<
  typeof postOperationsCaseMessageBodySchema
>;
export type ReviewEvidenceBody = z.infer<typeof reviewEvidenceBodySchema>;

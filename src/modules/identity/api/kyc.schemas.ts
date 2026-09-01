import { z } from "zod";

export const startKycSessionBodySchema = z.object({
  residence_country_code: z.string().regex(/^[A-Z]{2}$/),
  tax_residence_country_code: z.string().regex(/^[A-Z]{2}$/),
  language: z.string().regex(/^[a-z]{2}$/).optional(),
});

export const startKycSessionResponseSchema = z.object({
  data: z.object({
    verification_session_id: z.string().uuid(),
    verification_url: z.url(),
    eligibility_state: z.literal("not_started"),
  }),
});

export const startProofOfAddressSessionBodySchema = z.object({
  language: z.string().regex(/^[a-z]{2}$/).optional(),
});

export const startProofOfAddressSessionResponseSchema = z.object({
  data: z.object({
    verification_session_id: z.string().uuid(),
    verification_url: z.url(),
    proof_of_address_status: z.literal("in_progress"),
  }),
});

export const kycStatusResponseSchema = z.object({
  data: z.object({
    eligibility_state: z.enum([
      "not_started",
      "in_progress",
      "pending_manual_review",
      "eligible",
      "unsupported_jurisdiction",
      "not_eligible",
      "requires_renewal",
      "suspended_restricted",
    ]),
    proof_of_address_status: z.enum([
      "not_started",
      "creating",
      "creation_failed",
      "in_progress",
      "pending_manual_review",
      "current",
      "insufficient",
      "expired",
      "restart_required",
      "integration_anomaly",
    ]),
    proof_of_address_current_until: z.iso.datetime().nullable(),
    last_verified_at: z.iso.datetime().nullable(),
    renewal_due_at: z.iso.datetime().nullable(),
  }),
});

export const diditWebhookBodySchema = z
  .object({
    event_id: z.string().uuid(),
    webhook_type: z.string().min(1),
    timestamp: z.number().int().nonnegative(),
    created_at: z.number().int().nonnegative(),
    application_id: z.string().uuid(),
    environment: z.string().min(1),
    session_id: z.string().uuid(),
    session_kind: z.string().nullable().optional(),
    workflow_id: z.string().nullable().optional(),
    vendor_data: z.string().nullable().optional(),
    status: z.string().min(1),
  })
  .passthrough();

export const diditWebhookResponseSchema = z.object({
  received: z.literal(true),
  duplicate: z.literal(true).optional(),
  stale: z.literal(true).optional(),
  ignored: z.literal(true).optional(),
});

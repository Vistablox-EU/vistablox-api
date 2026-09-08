import { z } from "zod";

import { diditStatuses } from "../domain/kyc-policy.js";

const eligibilityStateSchema = z.enum([
  "not_started",
  "in_progress",
  "pending_manual_review",
  "eligible",
  "unsupported_jurisdiction",
  "not_eligible",
  "requires_renewal",
  "suspended_restricted",
]);

const proofOfAddressStatusSchema = z.enum([
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
]);

const operationalSubstatusSchema = z.enum([
  "kyc_not_started",
  "kyc_session_creating",
  "kyc_session_creation_failed",
  "kyc_session_open",
  "kyc_pending",
  "kyc_resubmission_pending",
  "kyc_manual_review",
  "kyc_verified_pending_policy_eval",
  "kyc_verified",
  "kyc_verified_owner_poa_missing",
  "kyc_jurisdiction_blocked",
  "kyc_failed",
  "kyc_restart_required",
  "kyc_reverification_required",
  "kyc_restricted",
  "kyc_integration_anomaly",
]);

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

// Only ever populated from a freshly re-fetched Didit decision, never a
// persisted column (docs/didit-kyc.md's data boundary excludes session
// tokens from storage) -- see GetKycStatusService.resolveActiveSession.
const activeSessionSchema = z.object({
  verification_session_id: z.string().uuid(),
  verification_url: z.url(),
  expires_at: z.iso.datetime().nullable(),
});

export const kycStatusResponseSchema = z.object({
  data: z.object({
    eligibility_state: eligibilityStateSchema,
    proof_of_address_status: proofOfAddressStatusSchema,
    proof_of_address_current_until: z.iso.datetime().nullable(),
    last_verified_at: z.iso.datetime().nullable(),
    renewal_due_at: z.iso.datetime().nullable(),
    active_session: activeSessionSchema.nullable(),
  }),
});

export const kycAccountIdParamsSchema = z.object({
  account_id: z.string().min(1),
});

// Operations-only view for authorized reviewers (admin_operations + staff
// WebAuthn): the same privacy-minimized eligibility record the customer's
// own GET /v1/kyc reads from, plus the operational detail a reviewer needs
// to understand *why* an account is stuck (operational_substatus, provider
// reference IDs, declared countries) that the customer-facing view omits.
// Never the raw Didit artifacts themselves (documents, biometrics, full
// provider payloads) — those were never persisted in the first place.
export const operationsKycAccountResponseSchema = z.object({
  data: z.object({
    account_id: z.string(),
    eligibility_state: eligibilityStateSchema,
    operational_substatus: operationalSubstatusSchema,
    didit_reference: z.string().nullable(),
    residence_country_code: z.string().nullable(),
    tax_residence_country_code: z.string().nullable(),
    proof_of_address_status: proofOfAddressStatusSchema,
    proof_of_address_didit_reference: z.string().nullable(),
    proof_of_address_provider_status: z.enum(diditStatuses).nullable(),
    proof_of_address_provider_updated_at: z.iso.datetime().nullable(),
    proof_of_address_current_until: z.iso.datetime().nullable(),
    last_verified_at: z.iso.datetime().nullable(),
    // Why renewal_due_at is 12 vs. 24 months out (KYC_WORKFLOW.md's Renewal
    // Policy) — not shown to the customer, whose own renewal_due_at date
    // already reflects it.
    ever_required_manual_review: z.boolean(),
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

// Durable-receipt acknowledgment only (AD-062 / ASYNC_JOBS.md's Webhook
// Handling Rule) — duplicate/stale/ignored outcomes are now determined by
// ProcessDiditWebhookService in the standalone KYC service
// (src/kyc-server.ts), after this response has already been sent, so they
// can no longer be reported synchronously here.
export const diditWebhookResponseSchema = z.object({
  received: z.literal(true),
});

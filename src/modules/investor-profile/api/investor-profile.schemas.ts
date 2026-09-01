import { z } from "zod";

const dateTime = z.iso.datetime();

export const investorProfileResponseSchema = z.object({
  data: z.object({
    account_id: z.string().min(1),
    account_status: z.enum(["active", "recovery_review", "suspended_restricted"]),
    contact_email: z.email().nullable(),
    member_since: dateTime,
    display_profile: z
      .object({
        given_name: z.string().min(1),
        family_name: z.string().min(1),
        full_display_name: z.string().min(1),
        last_synced_at: dateTime,
      })
      .nullable(),
    login_methods: z.array(
      z.object({
        method_type: z.enum(["google", "email_password"]),
        linked_at: dateTime,
      }),
    ),
    kyc: z.object({
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
      residence_country_code: z.string().regex(/^[A-Z]{2}$/).nullable(),
      tax_residence_country_code: z.string().regex(/^[A-Z]{2}$/).nullable(),
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
      proof_of_address_current_until: dateTime.nullable(),
      last_verified_at: dateTime.nullable(),
      renewal_due_at: dateTime.nullable(),
    }),
    investment_summary: z.object({
      reservation_count: z.number().int().nonnegative(),
      active_position_count: z.number().int().nonnegative(),
    }),
    readiness: z.object({
      investment_eligible: z.boolean(),
      payment_account_ready: z.boolean(),
      payout_account_verified: z.boolean(),
    }),
    wallet: z.object({
      status: z.enum(["not_registered", "pending", "registered"]),
      requested_at: dateTime.nullable(),
      registered_at: dateTime.nullable(),
    }),
  }),
});

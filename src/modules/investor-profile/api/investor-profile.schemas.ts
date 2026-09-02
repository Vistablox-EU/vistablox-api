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

export const registerWalletBodySchema = z.object({
  wallet_address: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a 20-byte, 0x-prefixed hex address"),
});

export const registerWalletResponseSchema = z.object({
  data: z.object({
    wallet_address: z.string().min(1),
    registration_commitment: z.string().min(1),
    status: z.enum(["pending", "registered"]),
    requested_at: dateTime,
    registered_at: dateTime.nullable(),
  }),
});

export const investorActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).optional(),
});

const investorPropertySummarySchema = z.object({
  property_type: z.literal("residential"),
  country_code: z.string().regex(/^[A-Z]{2}$/),
  city: z.string().nullable(),
});

export const investorReservationHistoryResponseSchema = z.object({
  data: z.array(
    z.object({
      reservation_id: z.string().min(1),
      offering_id: z.string().min(1),
      offering_status: z.enum(["pre_offering", "final_offering", "closed"]),
      amount_eur: z.string().regex(/^\d+\.\d{2}$/),
      reservation_stage: z.enum([
        "initiated",
        "awaiting_reconfirmation",
        "reconfirmed",
        "finalized",
        "cancelled",
        "lapsed",
      ]),
      disclosure_pack_version_at_reservation: z.string().nullable(),
      reconfirmed_at: dateTime.nullable(),
      reservation_finalized_at: dateTime.nullable(),
      created_at: dateTime,
      latest_capital_state: z
        .object({
          state: z.enum([
            "initiated",
            "eurc_purchase_pending",
            "purchase_failed",
            "eurc_reserved",
            "reconfirmation_pending",
            "eurc_finalized",
            "provider_disputed",
          ]),
          amount_eur: z.string().regex(/^\d+\.\d{2}$/),
          amount_eurc: z.string().regex(/^\d+\.\d{6}$/).nullable(),
          recorded_at: dateTime,
        })
        .nullable(),
      property: investorPropertySummarySchema,
    }),
  ),
  page: z.object({ next_cursor: z.string().nullable() }),
});

export const investorCurrentPositionsResponseSchema = z.object({
  data: z.array(
    z.object({
      position_id: z.string().min(1),
      reservation_id: z.string().min(1),
      offering_id: z.string().min(1),
      piv_id: z.string().min(1),
      unit_count: z.string().regex(/^\d+\.\d{6}$/),
      cost_basis_eur: z.string().regex(/^\d+\.\d{2}$/),
      position_status: z.enum(["pending_internal_settlement", "active"]),
      activated_at: dateTime.nullable(),
      property: investorPropertySummarySchema,
    }),
  ),
  page: z.object({ next_cursor: z.string().nullable() }),
});

export type InvestorActivityQuery = z.infer<typeof investorActivityQuerySchema>;

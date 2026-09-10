import { z } from "zod";

const dateTime = z.iso.datetime();

const localeSchema = z
  .string()
  .min(2)
  .max(35)
  .refine((value) => {
    try {
      return Boolean(new Intl.Locale(value).baseName);
    } catch {
      return false;
    }
  }, "Must be a valid BCP 47 locale tag (e.g. \"en-US\").");

// Intl.supportedValuesOf("timeZone") omits legacy-but-valid identifiers
// this ICU build still accepts (e.g. "UTC" itself, the stored default) --
// constructing a formatter with the zone is the accurate validity check.
const timezoneSchema = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Must be a valid IANA time zone (e.g. \"Europe/Berlin\").");

export const accountPreferencesSchema = z.object({
  deal_alerts_email: z.boolean(),
  statements_email: z.boolean(),
  marketing_email: z.boolean(),
  locale: localeSchema,
  timezone: timezoneSchema,
});

export const profileResponseSchema = z.object({
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
        method_type: z.enum(["passkey", "google", "apple"]),
        linked_at: dateTime,
        is_registration_method: z.boolean(),
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
    preferences: accountPreferencesSchema,
    pending_closure_request: z
      .object({
        reason: z.string().nullable(),
        requested_at: dateTime,
      })
      .nullable(),
  }),
});

export const updateAccountPreferencesBodySchema = z
  .object({
    deal_alerts_email: z.boolean().optional(),
    statements_email: z.boolean().optional(),
    marketing_email: z.boolean().optional(),
    locale: localeSchema.optional(),
    timezone: timezoneSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one preference field is required.",
  });

export const updateAccountPreferencesResponseSchema = z.object({
  data: accountPreferencesSchema,
});

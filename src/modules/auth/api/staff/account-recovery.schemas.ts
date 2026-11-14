import { z } from "zod";

export const accountRecoveryCaseParamsSchema = z.object({
  case_id: z.string().trim().min(1),
});

export const openAccountRecoveryCaseBodySchema = z.object({
  account_id: z.string().trim().min(1),
});

export const createRecoveryDiditSessionBodySchema = z.object({}).strict();

export const recordPrimaryRecoveryReviewBodySchema = z.object({
  corroboration_category: z.enum([
    "recent_deposit",
    "recent_investment",
    "last_login",
    "other_policy_approved",
  ]),
});

export const decideAccountRecoveryCaseBodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(1).max(2000),
});

export const completeAccountRecoveryBodySchema = z.object({}).strict();

const accountRecoveryCaseSchema = z.object({
  recovery_case_id: z.string(),
  account_id: z.string(),
  status: z.enum(["open", "approved", "rejected", "completed"]),
  fresh_didit_verification_ref: z.string().nullable(),
  reviewed_by_primary: z.string().nullable(),
  reviewed_by_secondary: z.string().nullable(),
  cooldown_ends_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  resolved_at: z.iso.datetime().nullable(),
});

export const accountRecoveryCaseResponseSchema = z.object({
  data: accountRecoveryCaseSchema,
});

export const createRecoveryDiditSessionResponseSchema = z.object({
  data: z.object({
    verification_url: z.url(),
    case: accountRecoveryCaseSchema,
  }),
});

const corroborationFactsSchema = z.object({
  last_deposit: z.object({ amount_eur: z.string(), recorded_at: z.iso.datetime() }).nullable(),
  last_reservation: z.object({ amount_eur: z.string(), created_at: z.iso.datetime() }).nullable(),
  last_login: z.object({ auth_method: z.string(), occurred_at: z.iso.datetime() }).nullable(),
});

export const getAccountRecoveryCaseResponseSchema = z.object({
  data: z.object({
    case: accountRecoveryCaseSchema,
    fresh_didit_verification_status: z.string().nullable(),
    corroboration_facts: corroborationFactsSchema,
  }),
});

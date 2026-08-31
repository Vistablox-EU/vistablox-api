import { z } from "zod";

export const staffAccountLifecycleParamsSchema = z.object({
  account_id: z.string().trim().min(1),
});

export const recoverStaffAccountBodySchema = z.object({}).strict();

export const offboardStaffAccountBodySchema = z.object({
  reason: z.enum(["employment_ended", "partner_firm_notice", "security_action"]),
});

export const recoverStaffAccountResponseSchema = z.object({
  data: z.object({
    recovery_started: z.literal(true),
    webauthn_reenrollment_required: z.literal(true),
  }),
});

export const offboardStaffAccountResponseSchema = z.object({
  data: z.object({ offboarded: z.literal(true) }),
});

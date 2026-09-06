import { z } from "zod";

const baseInvitationFields = {
  email: z.email().transform((value) => value.trim().toLowerCase()),
  display_name: z.string().trim().min(1).max(200),
};

export const issueStaffInvitationBodySchema = z.discriminatedUnion("role", [
  z.object({
    ...baseInvitationFields,
    role: z.literal("admin_operations"),
    legal_practice_id: z.null().optional().default(null),
    appraisal_firm_id: z.null().optional().default(null),
  }),
  z.object({
    ...baseInvitationFields,
    role: z.literal("legal_partner"),
    legal_practice_id: z.string().trim().min(1),
    appraisal_firm_id: z.null().optional().default(null),
  }),
  z.object({
    ...baseInvitationFields,
    role: z.literal("appraisal_partner"),
    legal_practice_id: z.null().optional().default(null),
    appraisal_firm_id: z.string().trim().min(1),
  }),
]);

export const issueStaffInvitationResponseSchema = z.object({
  data: z.object({
    invitation_id: z.string(),
    expires_at: z.iso.datetime(),
  }),
});

export const acceptStaffInvitationBodySchema = z.object({
  token: z.string().min(32).max(512),
});

export const acceptStaffInvitationResponseSchema = z.object({
  data: z.object({
    accepted: z.literal(true),
    account_id: z.string(),
    webauthn_enrollment_required: z.literal(true),
    passkey_registration_context: z.string().min(32),
  }),
});

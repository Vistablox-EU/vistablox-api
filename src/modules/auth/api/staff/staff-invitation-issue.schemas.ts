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
import { z } from "zod";

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
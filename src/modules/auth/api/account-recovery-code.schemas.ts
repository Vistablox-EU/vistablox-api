import { z } from "zod";

export const redeemAccountRecoveryCodeBodySchema = z.object({
  code: z.string().min(20).max(32),
});

export const rotateAccountRecoveryCodeResponseSchema = z.object({
  data: z.object({
    code: z.string(),
    created_at: z.string().datetime(),
  }),
});

export const redeemAccountRecoveryCodeResponseSchema = z.object({
  data: z.object({
    passkey_registration_context: z.string().min(32),
  }),
});

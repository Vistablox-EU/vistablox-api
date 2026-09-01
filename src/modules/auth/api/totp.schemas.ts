import { z } from "zod";

export const enrollTotpResponseSchema = z.object({
  data: z.object({
    otp_auth_uri: z.string(),
    secret: z.string(),
    backup_codes: z.array(z.string()),
  }),
});

export const verifyTotpBodySchema = z.object({
  code: z.string().min(6).max(11),
});

export const verifyTotpResponseSchema = z.object({
  data: z.object({
    verified: z.boolean(),
    method: z.enum(["totp", "backup_code"]).nullable(),
  }),
});

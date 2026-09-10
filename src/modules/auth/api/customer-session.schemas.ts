import { z } from "zod";

export const sessionIdParamsSchema = z.object({
  session_id: z.string().min(1),
});

export const dpopKeyParamsSchema = z.object({
  jkt: z.string().min(1),
});

export const revokeDeviceResponseSchema = z.object({
  data: z.object({ revoked_count: z.number().int().nonnegative() }),
});

export const listOwnSessionsResponseSchema = z.object({
  data: z.array(
    z.object({
      session_id: z.string(),
      channel: z.string(),
      device_label: z.string().nullable(),
      auth_method_at_login: z.string(),
      created_at: z.iso.datetime(),
      last_seen_at: z.iso.datetime(),
      status: z.string(),
      revocation_reason: z.string().nullable(),
      is_current: z.boolean(),
    }),
  ),
});

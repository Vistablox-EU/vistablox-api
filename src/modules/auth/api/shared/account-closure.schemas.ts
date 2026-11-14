import { z } from "zod";

export const requestAccountClosureBodySchema = z.object({
  reason: z.string().trim().min(1).max(1000).optional(),
});

export const decideAccountClosureRequestBodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().min(1).max(2000).optional(),
});

export const accountClosureRequestParamsSchema = z.object({
  request_id: z.string().trim().min(1),
});

const accountClosureRequestSchema = z.object({
  closure_request_id: z.string(),
  account_id: z.string(),
  status: z.enum(["pending", "approved", "rejected", "cancelled"]),
  reason: z.string().nullable(),
  requested_at: z.iso.datetime(),
  resolved_at: z.iso.datetime().nullable(),
  resolved_by: z.string().nullable(),
  resolution_note: z.string().nullable(),
});

export const accountClosureRequestResponseSchema = z.object({
  data: accountClosureRequestSchema,
});

export const listPendingAccountClosureRequestsResponseSchema = z.object({
  data: z.array(accountClosureRequestSchema),
});

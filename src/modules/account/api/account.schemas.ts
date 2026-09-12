import { z } from "zod";

export const searchAccountsQuerySchema = z.object({
  email: z.string().trim().min(1).max(320),
});

export const accountSummarySchema = z.object({
  account_id: z.string(),
  email: z.string().nullable(),
  status: z.enum(["active", "recovery_review", "suspended_restricted"]),
});

export const searchAccountsResponseSchema = z.object({
  data: z.array(accountSummarySchema),
});

export type SearchAccountsQuery = z.infer<typeof searchAccountsQuerySchema>;

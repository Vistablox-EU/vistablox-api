import { z } from "zod";

export const fieldErrorSchema = z.object({
  field: z.string(),
  code: z.string(),
  message: z.string(),
});

export const errorResponseSchema = z.object({
  type: z.string(),
  code: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  trace_id: z.string(),
  field_errors: z.array(fieldErrorSchema).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

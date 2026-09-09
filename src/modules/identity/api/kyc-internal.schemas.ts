import { z } from "zod";

// Request shapes for vistablox-kyc's internal-only API (vistablox-api ->
// vistablox-kyc, signature-verified, never reached directly by an external
// caller in the intended deployment). Unlike the customer-facing routes in
// kyc.router.ts, nothing here can trust a response.locals.authContext --
// there isn't one on this side -- so accountId/traceId arrive explicitly in
// the request and are validated the same as any other untrusted input.
export const internalKycStatusQuerySchema = z.object({
  account_id: z.string().min(1),
});

export const internalStartKycSessionBodySchema = z.object({
  account_id: z.string().min(1),
  trace_id: z.string().min(1),
  residence_country_code: z.string().regex(/^[A-Z]{2}$/),
  tax_residence_country_code: z.string().regex(/^[A-Z]{2}$/),
  language: z.string().regex(/^[a-z]{2}$/).optional(),
});

export const internalStartProofOfAddressSessionBodySchema = z.object({
  account_id: z.string().min(1),
  trace_id: z.string().min(1),
  language: z.string().regex(/^[a-z]{2}$/).optional(),
});

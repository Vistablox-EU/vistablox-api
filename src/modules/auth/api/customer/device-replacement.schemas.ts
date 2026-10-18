import { z } from "zod";

// The email code is six decimal digits (see device-replacement.service.ts
// generateCode). The verify route rejects anything else before touching a hash.
export const deviceReplacementVerifyRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});

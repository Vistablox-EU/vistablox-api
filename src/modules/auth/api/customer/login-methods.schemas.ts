import { z } from "zod";

export const unlinkLoginMethodParamsSchema = z.object({
  method_type: z.enum(["google", "apple"]),
});

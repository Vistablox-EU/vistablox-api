import { Router } from "express";
import { z } from "zod";

import type { DatabaseProbe } from "../../infrastructure/database/database-probe.js";
import { AppError } from "../../shared/errors/app-error.js";
import { sendValidated } from "../../shared/http/send-validated.js";

const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export function createHealthRouter(databaseProbe: DatabaseProbe): Router {
  const router = Router();

  router.get("/live", (_request, response) => {
    sendValidated(response, healthResponseSchema, { status: "ok" });
  });

  router.get("/ready", async (_request, response) => {
    try {
      await databaseProbe.check();
    } catch (cause) {
      throw new AppError({
        code: "infrastructure.database_unavailable",
        title: "Service unavailable",
        status: 503,
        detail: "The database dependency is unavailable.",
        cause,
      });
    }

    sendValidated(response, healthResponseSchema, { status: "ok" });
  });

  return router;
}

import express, { type Express, type Request, type Response } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";

import type { DatabaseProbe } from "./infrastructure/database/database-probe.js";
import { createHealthRouter } from "./modules/health/health.router.js";
import { createDiditWebhookRouter } from "./modules/identity/api/kyc.router.js";
import type { ReceiveDiditWebhookService } from "./modules/identity/application/kyc.service.js";
import type { DiditWebhookVerifier } from "./modules/identity/infrastructure/didit-webhook-verifier.js";
import { errorHandler } from "./shared/http/error-handler.js";
import { requestContext } from "./shared/http/request-context.js";

// The testable half of the KYC service, mirroring app.ts/createApp's own
// split from server.ts: this builds the Express app from already-constructed
// dependencies with no side effects (no DB/Redis/pg-boss connections), so it
// can be exercised with fakes in tests. kyc-server.ts owns the real wiring
// (Prisma, pg-boss, Didit client) and process lifecycle.
export interface KycAppDependencies {
  databaseProbe: DatabaseProbe;
  logger: Logger;
  webhookVerifier: DiditWebhookVerifier;
  receiveWebhook: ReceiveDiditWebhookService;
}

export function createKycApp(dependencies: KycAppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(
    pinoHttp<Request, Response>({
      logger: dependencies.logger,
      genReqId: (_request, response) => String(response.locals.traceId),
      customAttributeKeys: { reqId: "trace_id" },
    }),
  );
  app.use((request, response, next) => {
    response.locals.logger = request.log;
    next();
  });
  app.use(helmet());
  app.use(express.json({ limit: "1mb", type: "application/json" }));

  app.use("/health", createHealthRouter(dependencies.databaseProbe));
  app.use(
    "/webhooks/didit",
    createDiditWebhookRouter(dependencies.webhookVerifier, dependencies.receiveWebhook),
  );

  app.use(errorHandler);
  return app;
}

import "dotenv/config";

import { PgBoss } from "pg-boss";
import { createClient } from "redis";

import { loadKycEnvironment } from "./config/kyc-environment.js";
import { RedisProtectedProfileCache } from "./infrastructure/cache/redis-protected-profile-cache.js";
import { PrismaDatabaseProbe } from "./infrastructure/database/database-probe.js";
import { createPrismaClient } from "./infrastructure/database/prisma.js";
import { createLogger } from "./infrastructure/logging/logger.js";
import { createKycApp } from "./kyc-app.js";
import {
  ProcessDiditWebhookService,
  ReceiveDiditWebhookService,
} from "./modules/identity/application/kyc.service.js";
import { DiditWebhookVerifier } from "./modules/identity/infrastructure/didit-webhook-verifier.js";
import { HttpDiditClient } from "./modules/identity/infrastructure/didit.client.js";
import { PrismaKycRepository } from "./modules/identity/repository/prisma-kyc.repository.js";

// Standalone deployable owning only the Didit webhook (receive, verify,
// durably enqueue, and process) -- Phase 2 of the KYC microservicing effort
// following PR #34's KycEligibilityReader boundary. /v1/kyc (session
// start/status), /internal/v1/kyc-accounts (staff review), and
// KycEligibility itself deliberately stay in vistablox-api/vistablox-worker
// for now: this service never creates a Didit session or authenticates a
// customer/staff caller, so it doesn't need DIDIT_CALLBACK_URL or any
// session-resolution capability, only what verifying and applying an
// already-created session's outcome requires.

const environment = loadKycEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
const database = createPrismaClient(environment.DATABASE_URL);
const boss = new PgBoss(environment.DATABASE_URL);
boss.on("error", (error) => {
  logger.error({ err: error }, "pg-boss error");
});

const kycRepository = new PrismaKycRepository(database, boss);
const diditClient = new HttpDiditClient({
  baseUrl: environment.DIDIT_API_BASE_URL,
  apiKey: environment.DIDIT_API_KEY,
  timeoutMs: 4_000,
});
const webhookVerifier = new DiditWebhookVerifier(environment.DIDIT_WEBHOOK_SECRET);

// Mirrors server.ts/worker.ts's own best-effort protected-profile-cache
// wiring: this process now owns the only code path that invalidates that
// cache on a KYC state change, so it needs the same optional Redis
// capability those processes already had, to preserve that behavior
// unchanged now that webhook processing lives here instead.
const profileCacheClient =
  environment.PROFILE_CACHE_URL === undefined
    ? undefined
    : createClient({
        url: environment.PROFILE_CACHE_URL,
        socket: { connectTimeout: 3_000, reconnectStrategy: false },
      });
profileCacheClient?.on("error", (error) => {
  logger.warn({ err: error }, "protected profile cache connection error");
});
if (profileCacheClient !== undefined) {
  try {
    await profileCacheClient.connect();
  } catch (error) {
    logger.warn(
      { err: error },
      "protected profile cache unavailable; display-name invalidation on KYC events will be skipped",
    );
  }
}
const protectedProfileCache =
  profileCacheClient?.isReady === true
    ? new RedisProtectedProfileCache(profileCacheClient)
    : undefined;

const processDiditWebhook = new ProcessDiditWebhookService(
  kycRepository,
  diditClient,
  {
    workflowId: environment.DIDIT_WORKFLOW_ID,
    applicationId: environment.DIDIT_APPLICATION_ID,
    environment: environment.DIDIT_ENVIRONMENT,
    ...(environment.DIDIT_POA_WORKFLOW_ID === undefined
      ? {}
      : { proofOfAddressWorkflowId: environment.DIDIT_POA_WORKFLOW_ID }),
  },
  protectedProfileCache === undefined
    ? undefined
    : async (accountId: string) => {
        try {
          await protectedProfileCache.delete(accountId);
        } catch (error) {
          logger.warn(
            { err: error, account_id: accountId },
            "protected display profile cache invalidation failed",
          );
        }
      },
);

await boss.start();
// createQueue is ON CONFLICT DO NOTHING -- same convention server.ts/
// worker.ts already rely on, safe to run on every start.
await boss.createQueue("provider_events.didit_webhook");
await boss.work("provider_events.didit_webhook", async (jobs) => {
  for (const job of jobs) {
    const traceId =
      typeof job.data === "object" && job.data !== null && "traceId" in job.data
        ? String((job.data as { traceId: unknown }).traceId)
        : "unknown";
    try {
      const result = await processDiditWebhook.execute(job.data);
      logger.info(
        { trace_id: traceId, job: "provider_events.didit_webhook", ...result },
        "webhook job completed",
      );
    } catch (error) {
      logger.error(
        { err: error, trace_id: traceId, job: "provider_events.didit_webhook" },
        "webhook job failed",
      );
      throw error;
    }
  }
});

const app = createKycApp({
  databaseProbe: new PrismaDatabaseProbe(database),
  logger,
  webhookVerifier,
  receiveWebhook: new ReceiveDiditWebhookService(kycRepository),
});

const server = app.listen(environment.PORT, environment.HOST, () => {
  logger.info(
    { host: environment.HOST, port: environment.PORT },
    "VistaBlox KYC service listening",
  );
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "shutting down");
  server.close(async (error) => {
    const shutdownTasks: Promise<unknown>[] = [database.$disconnect(), boss.stop()];
    if (profileCacheClient?.isOpen === true) {
      shutdownTasks.push(profileCacheClient.close());
    }
    await Promise.all(shutdownTasks);
    if (error !== undefined) {
      logger.error({ err: error }, "HTTP server shutdown failed");
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

import "dotenv/config";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { ulid } from "ulid";

import { loadEnvironment } from "./config/environment.js";
import { createPrismaClient } from "./infrastructure/database/prisma.js";
import { SmtpEmailSender } from "./infrastructure/email/smtp-email-sender.js";
import { createLogger } from "./infrastructure/logging/logger.js";
import {
  ExpireOverdueInformationRequestsService,
  SendApplicantResponseRemindersService,
} from "./modules/origination/application/case-timer.service.js";
import { PrismaOriginationRepository } from "./modules/origination/repository/prisma-origination.repository.js";
import { RunKycRenewalTimerService } from "./modules/identity/application/kyc-renewal.service.js";
import { PrismaKycRepository } from "./modules/identity/repository/prisma-kyc.repository.js";
import { RunOidcCleanupService } from "./modules/auth/application/oidc-cleanup.service.js";
import { PostgresOidcCleanupRepository } from "./modules/auth/infrastructure/postgres-oidc-cleanup.repository.js";
import type { JobRunSummary } from "./shared/jobs/job-run-summary.js";

const environment = loadEnvironment();
const logger = createLogger(environment.LOG_LEVEL);
const database = createPrismaClient(environment.DATABASE_URL);
const authDatabase = new Pool({ connectionString: environment.DATABASE_URL });
const emailSender = new SmtpEmailSender({
  host: environment.SMTP_HOST,
  port: environment.SMTP_PORT,
  secure: environment.SMTP_SECURE,
  user: environment.SMTP_USER,
  password: environment.SMTP_PASSWORD,
  from: environment.SMTP_FROM,
});
const originationRepository = new PrismaOriginationRepository(database);
const kycRepository = new PrismaKycRepository(database);

const sendApplicantReminders = new SendApplicantResponseRemindersService(
  originationRepository,
  emailSender,
);
const expireOverdueRequests = new ExpireOverdueInformationRequestsService(originationRepository);
const runKycRenewalTimer = new RunKycRenewalTimerService(kycRepository, emailSender);
const runOidcCleanup = new RunOidcCleanupService(new PostgresOidcCleanupRepository(authDatabase));

// AD-135's worker/queue runbook family and ASYNC_JOBS.md's retry baseline:
// up to 5 attempts, exponential backoff with jitter (pg-boss's own
// retryBackoff formula already includes jitter).
const RETRY_OPTIONS = { retryLimit: 5, retryBackoff: true } as const;

const boss = new PgBoss(environment.DATABASE_URL);
boss.on("error", (error) => {
  logger.error({ err: error }, "pg-boss error");
});

async function runJob(name: string, run: (traceId: string) => Promise<JobRunSummary>): Promise<void> {
  const traceId = `req_${ulid()}`;
  try {
    const summary = await run(traceId);
    logger.info({ trace_id: traceId, job: name, ...summary }, "case timer job completed");
  } catch (error) {
    logger.error({ err: error, trace_id: traceId, job: name }, "case timer job failed");
    throw error;
  }
}

await boss.start();

// pg-boss v12 requires a queue to exist (queue.name has a foreign key from
// job.name) before scheduling or working it; createQueue is ON CONFLICT DO
// NOTHING, so this is safe to run on every worker start.
await boss.createQueue("case_timers.applicant_reminders");
await boss.createQueue("case_timers.response_window_expiry");
await boss.createQueue("maintenance.kyc_renewal");
await boss.createQueue("maintenance.oidc_cleanup");

await boss.schedule("case_timers.applicant_reminders", "0 8 * * *", null, {
  tz: "UTC",
  ...RETRY_OPTIONS,
});
await boss.schedule("case_timers.response_window_expiry", "0 * * * *", null, {
  tz: "UTC",
  ...RETRY_OPTIONS,
});
await boss.schedule("maintenance.kyc_renewal", "0 9 * * *", null, {
  tz: "UTC",
  ...RETRY_OPTIONS,
});
await boss.schedule("maintenance.oidc_cleanup", "0 * * * *", null, {
  tz: "UTC",
  ...RETRY_OPTIONS,
});

await boss.work("case_timers.applicant_reminders", async () => {
  await runJob("case_timers.applicant_reminders", () => sendApplicantReminders.execute());
});
await boss.work("case_timers.response_window_expiry", async () => {
  await runJob("case_timers.response_window_expiry", (traceId) =>
    expireOverdueRequests.execute(traceId),
  );
});
await boss.work("maintenance.kyc_renewal", async () => {
  await runJob("maintenance.kyc_renewal", (traceId) => runKycRenewalTimer.execute(traceId));
});
await boss.work("maintenance.oidc_cleanup", async () => {
  await runJob("maintenance.oidc_cleanup", () => runOidcCleanup.execute());
});

logger.info("VistaBlox worker started");

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "worker shutting down");
  try {
    await boss.stop();
  } catch (error: unknown) {
    logger.error({ err: error }, "pg-boss shutdown failed");
  }
  await Promise.all([database.$disconnect(), authDatabase.end()]);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

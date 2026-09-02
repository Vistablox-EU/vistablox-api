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
import { OpenOfferingForApprovedCaseService } from "./modules/offering/application/open-offering-for-approved-case.service.js";
import { ExpireUnfundedReservationsService } from "./modules/offering/application/expire-reservations.service.js";
import { PollOnrampTransactionsService } from "./modules/offering/application/poll-onramp-transactions.service.js";
import { CommitOfferingFinalizationService } from "./modules/offering/application/commit-offering-finalization.service.js";
import { PrismaOfferingRepository } from "./modules/offering/repository/prisma-offering.repository.js";
import { HttpCoinbaseCdpClient } from "./modules/offering/infrastructure/http-coinbase-cdp.client.js";
import { JOB_RETRY_OPTIONS } from "./shared/jobs/enqueue-job.js";
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
const kycRepository = new PrismaKycRepository(database);
const offeringRepository = new PrismaOfferingRepository(database);

const boss = new PgBoss(environment.DATABASE_URL);
boss.on("error", (error) => {
  logger.error({ err: error }, "pg-boss error");
});

const originationRepository = new PrismaOriginationRepository(database, boss);
const sendApplicantReminders = new SendApplicantResponseRemindersService(
  originationRepository,
  emailSender,
);
const expireOverdueRequests = new ExpireOverdueInformationRequestsService(originationRepository);
const runKycRenewalTimer = new RunKycRenewalTimerService(kycRepository, emailSender);
const runOidcCleanup = new RunOidcCleanupService(new PostgresOidcCleanupRepository(authDatabase));
const openOfferingForApprovedCase = new OpenOfferingForApprovedCaseService(offeringRepository);
const expireUnfundedReservations = new ExpireUnfundedReservationsService(offeringRepository);
const commitOfferingFinalization = new CommitOfferingFinalizationService(offeringRepository);
const coinbaseCdpClient =
  environment.COINBASE_CDP_API_KEY_ID === undefined || environment.COINBASE_CDP_API_KEY_SECRET === undefined
    ? undefined
    : new HttpCoinbaseCdpClient({
        baseUrl: environment.COINBASE_CDP_API_BASE_URL,
        payHostedUrl: environment.COINBASE_CDP_PAY_HOSTED_URL,
        apiKeyId: environment.COINBASE_CDP_API_KEY_ID,
        apiKeySecret: environment.COINBASE_CDP_API_KEY_SECRET,
        timeoutMs: 8_000,
      });
const pollOnrampTransactions =
  coinbaseCdpClient === undefined
    ? undefined
    : new PollOnrampTransactionsService(offeringRepository, coinbaseCdpClient);

const RETRY_OPTIONS = JOB_RETRY_OPTIONS;

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
await boss.createQueue("case_timers.pre_offering_open_handoff");
await boss.createQueue("case_timers.reservation_unfunded_expiry");
await boss.createQueue("case_timers.offering_reconfirmation_window_close");
await boss.createQueue("maintenance.kyc_renewal");
await boss.createQueue("maintenance.oidc_cleanup");
// Only registered when Coinbase CDP credentials are configured — unlike
// every other job here, this one's sole dependency (the onramp REST client)
// is genuinely optional, matching how server.ts only wires reservation
// creation itself when the same credentials are present.
if (pollOnrampTransactions !== undefined) {
  await boss.createQueue("case_timers.reservation_onramp_poll");
}

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
// Every minute, not hourly like the other timers above: the capacity-hold
// policy decided alongside AD-255 promises unfunded capacity is released
// within ~15 minutes, and a stale hold blocks other investors from an
// offering that may be close to full — a coarser sweep would silently widen
// that window.
await boss.schedule("case_timers.reservation_unfunded_expiry", "* * * * *", null, {
  tz: "UTC",
  ...RETRY_OPTIONS,
});
// Hourly, like this worker's other longer-horizon timers: the window is
// 168 hours (AD-214), so per-minute precision buys nothing an investor
// would notice, unlike the 15-minute reservation-expiry sweep above.
await boss.schedule("case_timers.offering_reconfirmation_window_close", "0 * * * *", null, {
  tz: "UTC",
  ...RETRY_OPTIONS,
});
if (pollOnrampTransactions !== undefined) {
  await boss.schedule("case_timers.reservation_onramp_poll", "* * * * *", null, {
    tz: "UTC",
    ...RETRY_OPTIONS,
  });
}

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
await boss.work("case_timers.reservation_unfunded_expiry", async () => {
  await runJob("case_timers.reservation_unfunded_expiry", (traceId) =>
    expireUnfundedReservations.execute(traceId),
  );
});
await boss.work("case_timers.offering_reconfirmation_window_close", async () => {
  await runJob("case_timers.offering_reconfirmation_window_close", (traceId) =>
    commitOfferingFinalization.execute(traceId),
  );
});
if (pollOnrampTransactions !== undefined) {
  await boss.work("case_timers.reservation_onramp_poll", async () => {
    await runJob("case_timers.reservation_onramp_poll", () => pollOnrampTransactions.execute());
  });
}

// AD-152: this job's trace_id is the originating approval request's own,
// carried forward by the enqueue path — never a freshly minted one, unlike
// runJob's scheduled jobs above which have no originating request.
await boss.work("case_timers.pre_offering_open_handoff", async (jobs) => {
  for (const job of jobs) {
    const traceId =
      typeof job.data === "object" && job.data !== null && "trace_id" in job.data
        ? String((job.data as { trace_id: unknown }).trace_id)
        : "unknown";
    try {
      const result = await openOfferingForApprovedCase.execute(job.data);
      logger.info(
        { trace_id: traceId, job: "case_timers.pre_offering_open_handoff", ...result },
        "case timer job completed",
      );
    } catch (error) {
      logger.error(
        { err: error, trace_id: traceId, job: "case_timers.pre_offering_open_handoff" },
        "case timer job failed",
      );
      throw error;
    }
  }
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

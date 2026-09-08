import "dotenv/config";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { createClient } from "redis";
import { ulid } from "ulid";

import { loadEnvironment } from "./config/environment.js";
import { RedisProtectedProfileCache } from "./infrastructure/cache/redis-protected-profile-cache.js";
import { createPrismaClient } from "./infrastructure/database/prisma.js";
import { SmtpEmailSender } from "./infrastructure/email/smtp-email-sender.js";
import { createLogger } from "./infrastructure/logging/logger.js";
import {
  ExpireOverdueInformationRequestsService,
  SendApplicantResponseRemindersService,
} from "./modules/origination/application/case-timer.service.js";
import { TransitionCaseToPostIpoStructuringService } from "./modules/origination/application/post-ipo-structuring-handoff.service.js";
import { PrismaOriginationRepository } from "./modules/origination/repository/prisma-origination.repository.js";
import { HttpDiditClient } from "./modules/identity/infrastructure/didit.client.js";
import { ProcessDiditWebhookService } from "./modules/identity/application/kyc.service.js";
import { RunKycRenewalTimerService } from "./modules/identity/application/kyc-renewal.service.js";
import {
  ExpireStuckSessionCreationsService,
  ReconcileStuckOpenSessionsService,
} from "./modules/identity/application/kyc-stuck-session.service.js";
import { PrismaKycRepository } from "./modules/identity/repository/prisma-kyc.repository.js";
import { RunOidcCleanupService } from "./modules/auth/application/oidc-cleanup.service.js";
import { PostgresOidcCleanupRepository } from "./modules/auth/infrastructure/postgres-oidc-cleanup.repository.js";
import { OpenOfferingForApprovedCaseService } from "./modules/offering/application/open-offering-for-approved-case.service.js";
import { ExpireUnfundedReservationsService } from "./modules/offering/application/expire-reservations.service.js";
import { PollOnrampTransactionsService } from "./modules/offering/application/poll-onramp-transactions.service.js";
import { CommitOfferingFinalizationService } from "./modules/offering/application/commit-offering-finalization.service.js";
import { SendReconfirmationRemindersService } from "./modules/offering/application/send-reconfirmation-reminders.service.js";
import { NotifyReconfirmationWindowOpenedService } from "./modules/offering/application/notify-reconfirmation-window-opened.service.js";
import { PrismaOfferingRepository } from "./modules/offering/repository/prisma-offering.repository.js";
import { HttpCoinbaseCdpClient } from "./modules/offering/infrastructure/http-coinbase-cdp.client.js";
import { CalculateOperatingDistributionService } from "./modules/rental/application/calculate-operating-distribution.service.js";
import { RunOperatingDistributionSweepService } from "./modules/rental/application/run-operating-distribution-sweep.service.js";
import { PrismaOperatingDistributionRepository } from "./modules/rental/repository/prisma-operating-distribution.repository.js";
import { OpenIpoEscrowCampaignService } from "./modules/settlement/application/open-ipo-escrow-campaign.service.js";
import { FinalizeIpoEscrowCampaignsService } from "./modules/settlement/application/finalize-ipo-escrow-campaigns.service.js";
import { PrismaSettlementRepository } from "./modules/settlement/repository/prisma-settlement.repository.js";
import { createChainClients } from "./infrastructure/blockchain/chain-client.js";
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
const boss = new PgBoss(environment.DATABASE_URL);
boss.on("error", (error) => {
  logger.error({ err: error }, "pg-boss error");
});

const kycRepository = new PrismaKycRepository(database, boss);
// Mirrors server.ts's own protected-profile-cache wiring: the display-name
// cache invalidation that used to run inline inside the webhook HTTP
// request (ProcessDiditWebhookService) now runs here instead, since that
// service itself moved to this worker (see provider_events.didit_webhook
// below) — this process needs the same best-effort Redis capability
// server.ts already has to preserve that behavior unchanged.
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
const diditClient =
  environment.DIDIT_API_KEY === undefined
    ? undefined
    : new HttpDiditClient({
        baseUrl: environment.DIDIT_API_BASE_URL,
        apiKey: environment.DIDIT_API_KEY,
        timeoutMs: 4_000,
      });
// Same "configure all six together or leave all empty" gate server.ts uses
// for diditKyc — this worker only needs four of the six (callbackUrl and
// webhookSecret are session-start/signature-verification concerns that stay
// in the API process), but checking all six keeps the two processes'
// notion of "is Didit configured" from ever disagreeing.
const processDiditWebhook =
  diditClient !== undefined &&
  environment.DIDIT_WORKFLOW_ID !== undefined &&
  environment.DIDIT_CALLBACK_URL !== undefined &&
  environment.DIDIT_WEBHOOK_SECRET !== undefined &&
  environment.DIDIT_APPLICATION_ID !== undefined &&
  environment.DIDIT_ENVIRONMENT !== undefined
    ? new ProcessDiditWebhookService(
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
      )
    : undefined;
const expireStuckSessionCreations = new ExpireStuckSessionCreationsService(kycRepository);
// Only needs a live DiditClient (to re-query a session's current status),
// not the full six-variable Didit config processDiditWebhook above checks
// — diditClient !== undefined is already equivalent in practice, since
// environment.ts's own refine enforces all six configured together or none.
const reconcileStuckOpenSessions =
  diditClient === undefined ? undefined : new ReconcileStuckOpenSessionsService(kycRepository, diditClient);

const offeringRepository = new PrismaOfferingRepository(database, boss, kycRepository);
const originationRepository = new PrismaOriginationRepository(database, boss, kycRepository);
const sendApplicantReminders = new SendApplicantResponseRemindersService(
  originationRepository,
  emailSender,
);
const expireOverdueRequests = new ExpireOverdueInformationRequestsService(originationRepository);
const transitionCaseToPostIpoStructuring = new TransitionCaseToPostIpoStructuringService(originationRepository);
const runKycRenewalTimer = new RunKycRenewalTimerService(kycRepository, emailSender);
const runOidcCleanup = new RunOidcCleanupService(new PostgresOidcCleanupRepository(authDatabase));
const openOfferingForApprovedCase = new OpenOfferingForApprovedCaseService(offeringRepository);
const expireUnfundedReservations = new ExpireUnfundedReservationsService(offeringRepository);
const commitOfferingFinalization = new CommitOfferingFinalizationService(offeringRepository);
const sendReconfirmationReminders = new SendReconfirmationRemindersService(offeringRepository, emailSender);
const notifyReconfirmationWindowOpened = new NotifyReconfirmationWindowOpenedService(offeringRepository, emailSender);
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

const operatingDistributionRepository = new PrismaOperatingDistributionRepository(database);
const calculateOperatingDistribution = new CalculateOperatingDistributionService(
  operatingDistributionRepository,
);
// Dormant unless OPERATING_DISTRIBUTION_ENABLED (AD-234's pattern) -- built
// ahead of AD-232/AD-206's named trigger at the founder's direction.
const runOperatingDistributionSweep = environment.OPERATING_DISTRIBUTION_ENABLED
  ? new RunOperatingDistributionSweepService(operatingDistributionRepository, calculateOperatingDistribution)
  : undefined;

// Optional on-chain settlement integration (AD-163/AD-256), same
// all-configured-together-or-none gate environment.ts's own refine already
// enforces -- mirrors coinbaseCdpClient's construction just above.
const chainClients =
  environment.CHAIN_NETWORK === undefined ||
  environment.CHAIN_RPC_URL === undefined ||
  environment.CHAIN_OPERATOR_PRIVATE_KEY === undefined ||
  environment.VISTABLOX_PROPERTY_CONTRACT_ADDRESS === undefined ||
  environment.VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS === undefined ||
  environment.EURC_TOKEN_ADDRESS === undefined ||
  environment.PIV_TREASURY_ADDRESS === undefined
    ? undefined
    : createChainClients({
        network: environment.CHAIN_NETWORK,
        rpcUrl: environment.CHAIN_RPC_URL,
        operatorPrivateKey: environment.CHAIN_OPERATOR_PRIVATE_KEY as `0x${string}`,
        propertyContractAddress: environment.VISTABLOX_PROPERTY_CONTRACT_ADDRESS as `0x${string}`,
        ipoEscrowContractAddress: environment.VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS as `0x${string}`,
        eurcTokenAddress: environment.EURC_TOKEN_ADDRESS as `0x${string}`,
        pivTreasuryAddress: environment.PIV_TREASURY_ADDRESS as `0x${string}`,
      });
const openIpoEscrowCampaign =
  chainClients === undefined ? undefined : new OpenIpoEscrowCampaignService(chainClients);
const settlementRepository = chainClients === undefined ? undefined : new PrismaSettlementRepository(database);
const finalizeIpoEscrowCampaigns =
  chainClients === undefined || settlementRepository === undefined
    ? undefined
    : new FinalizeIpoEscrowCampaignsService(settlementRepository, chainClients);

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
await boss.createQueue("case_timers.offering_reconfirmation_reminders");
await boss.createQueue("case_timers.offering_reconfirmation_window_opened");
await boss.createQueue("case_timers.post_ipo_structuring_handoff");
await boss.createQueue("maintenance.kyc_renewal");
await boss.createQueue("maintenance.oidc_cleanup");
await boss.createQueue("maintenance.kyc_stuck_session_expiry");
// Only registered when Coinbase CDP credentials are configured — unlike
// every other job here, this one's sole dependency (the onramp REST client)
// is genuinely optional, matching how server.ts only wires reservation
// creation itself when the same credentials are present.
if (pollOnrampTransactions !== undefined) {
  await boss.createQueue("case_timers.reservation_onramp_poll");
}
// Only registered when Didit is configured, the same all-or-nothing gate
// as processDiditWebhook's own construction above.
if (processDiditWebhook !== undefined) {
  await boss.createQueue("provider_events.didit_webhook");
}
if (reconcileStuckOpenSessions !== undefined) {
  await boss.createQueue("maintenance.kyc_stuck_session_reconciliation");
}
if (runOperatingDistributionSweep !== undefined) {
  await boss.createQueue("rental.operating_distribution_sweep");
}
if (openIpoEscrowCampaign !== undefined) {
  await boss.createQueue("settlement.open_ipo_escrow_campaign");
}
if (finalizeIpoEscrowCampaigns !== undefined) {
  await boss.createQueue("settlement.finalize_ipo_escrow_campaigns");
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
// Hourly is generous headroom either side of both thresholds this pair
// checks against (15 minutes for a stuck session creation, an hour before
// the first reconciliation re-check of a stuck open session) — there is no
// promised recovery time to keep pace with here, unlike the 15-minute
// unfunded-reservation sweep above.
await boss.schedule("maintenance.kyc_stuck_session_expiry", "0 * * * *", null, {
  tz: "UTC",
  ...RETRY_OPTIONS,
});
if (reconcileStuckOpenSessions !== undefined) {
  await boss.schedule("maintenance.kyc_stuck_session_reconciliation", "0 * * * *", null, {
    tz: "UTC",
    ...RETRY_OPTIONS,
  });
}
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
// Also hourly — isReconfirmationReminderDue derives due-ness from time
// elapsed since the last reminder actually sent, not a calendar-day match,
// so it stays correct regardless of this schedule's exact cadence; hourly
// just keeps it consistent with this worker's other longer-horizon timers.
await boss.schedule("case_timers.offering_reconfirmation_reminders", "0 * * * *", null, {
  tz: "UTC",
  ...RETRY_OPTIONS,
});
if (pollOnrampTransactions !== undefined) {
  await boss.schedule("case_timers.reservation_onramp_poll", "* * * * *", null, {
    tz: "UTC",
    ...RETRY_OPTIONS,
  });
}
if (finalizeIpoEscrowCampaigns !== undefined) {
  // Hourly, like this worker's other longer-horizon timers: an IPO window
  // runs on the order of days to weeks (AD-244), so per-minute precision
  // buys nothing an investor would notice, same reasoning as
  // case_timers.offering_reconfirmation_window_close above.
  await boss.schedule("settlement.finalize_ipo_escrow_campaigns", "0 * * * *", null, {
    tz: "UTC",
    ...RETRY_OPTIONS,
  });
}
if (runOperatingDistributionSweep !== undefined) {
  // Monthly, 1st at 06:00 UTC — matches this worker's other daily/monthly
  // timers' plain top-of-period convention (case_timers.applicant_reminders
  // is "0 8 * * *"); nothing here is latency-sensitive enough to need
  // off-the-hour jitter the way a public-facing API endpoint would.
  await boss.schedule("rental.operating_distribution_sweep", "0 6 1 * *", null, {
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
await boss.work("maintenance.kyc_stuck_session_expiry", async () => {
  await runJob("maintenance.kyc_stuck_session_expiry", (traceId) =>
    expireStuckSessionCreations.execute(traceId),
  );
});
if (reconcileStuckOpenSessions !== undefined) {
  await boss.work("maintenance.kyc_stuck_session_reconciliation", async () => {
    await runJob("maintenance.kyc_stuck_session_reconciliation", (traceId) =>
      reconcileStuckOpenSessions.execute(traceId),
    );
  });
}
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
await boss.work("case_timers.offering_reconfirmation_reminders", async () => {
  await runJob("case_timers.offering_reconfirmation_reminders", (traceId) =>
    sendReconfirmationReminders.execute(traceId),
  );
});
if (pollOnrampTransactions !== undefined) {
  await boss.work("case_timers.reservation_onramp_poll", async () => {
    await runJob("case_timers.reservation_onramp_poll", () => pollOnrampTransactions.execute());
  });
}
if (runOperatingDistributionSweep !== undefined) {
  await boss.work("rental.operating_distribution_sweep", async () => {
    await runJob("rental.operating_distribution_sweep", () => runOperatingDistributionSweep.execute());
  });
}
if (finalizeIpoEscrowCampaigns !== undefined) {
  // Not routed through runJob: its richer, multi-counter summary (finalized
  // / successful / failed / positions minted / per-campaign errors) is more
  // useful here than JobRunSummary's generic checked/acted pair would be.
  await boss.work("settlement.finalize_ipo_escrow_campaigns", async () => {
    const traceId = `req_${ulid()}`;
    try {
      const summary = await finalizeIpoEscrowCampaigns.execute();
      logger.info(
        { trace_id: traceId, job: "settlement.finalize_ipo_escrow_campaigns", ...summary },
        "case timer job completed",
      );
    } catch (error) {
      logger.error(
        { err: error, trace_id: traceId, job: "settlement.finalize_ipo_escrow_campaigns" },
        "case timer job failed",
      );
      throw error;
    }
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

// AD-152: this job's trace_id is the originating founder-approval request's
// own, carried forward from PrismaOfferingRepository.openOfferingForApprovedCase's
// enqueue (AD-256) -- the same pattern case_timers.pre_offering_open_handoff
// above already uses.
if (openIpoEscrowCampaign !== undefined) {
  await boss.work("settlement.open_ipo_escrow_campaign", async (jobs) => {
    for (const job of jobs) {
      const traceId =
        typeof job.data === "object" && job.data !== null && "trace_id" in job.data
          ? String((job.data as { trace_id: unknown }).trace_id)
          : "unknown";
      try {
        const result = await openIpoEscrowCampaign.execute(job.data);
        logger.info(
          { trace_id: traceId, job: "settlement.open_ipo_escrow_campaign", ...result },
          "case timer job completed",
        );
      } catch (error) {
        logger.error(
          { err: error, trace_id: traceId, job: "settlement.open_ipo_escrow_campaign" },
          "case timer job failed",
        );
        throw error;
      }
    }
  });
}

// AD-152: this job's trace_id is the originating publishFinalOfferingTerms
// request's own, carried forward by the enqueue path — the same pattern
// case_timers.pre_offering_open_handoff above already uses.
await boss.work("case_timers.offering_reconfirmation_window_opened", async (jobs) => {
  for (const job of jobs) {
    const traceId =
      typeof job.data === "object" && job.data !== null && "trace_id" in job.data
        ? String((job.data as { trace_id: unknown }).trace_id)
        : "unknown";
    try {
      const result = await notifyReconfirmationWindowOpened.execute(job.data);
      logger.info(
        { trace_id: traceId, job: "case_timers.offering_reconfirmation_window_opened", ...result },
        "case timer job completed",
      );
    } catch (error) {
      logger.error(
        { err: error, trace_id: traceId, job: "case_timers.offering_reconfirmation_window_opened" },
        "case timer job failed",
      );
      throw error;
    }
  }
});

// AD-152: this job's trace_id is the originating publishFinalOfferingTerms
// request's own, carried forward by the enqueue path — the same pattern
// case_timers.pre_offering_open_handoff above already uses.
await boss.work("case_timers.post_ipo_structuring_handoff", async (jobs) => {
  for (const job of jobs) {
    const traceId =
      typeof job.data === "object" && job.data !== null && "trace_id" in job.data
        ? String((job.data as { trace_id: unknown }).trace_id)
        : "unknown";
    try {
      const result = await transitionCaseToPostIpoStructuring.execute(job.data);
      logger.info(
        { trace_id: traceId, job: "case_timers.post_ipo_structuring_handoff", ...result },
        "case timer job completed",
      );
    } catch (error) {
      logger.error(
        { err: error, trace_id: traceId, job: "case_timers.post_ipo_structuring_handoff" },
        "case timer job failed",
      );
      throw error;
    }
  }
});

if (processDiditWebhook !== undefined) {
  // AD-062 / ASYNC_JOBS.md's Webhook Handling Rule: this is the "workers
  // own the actual business processing" half — ReceiveDiditWebhookService
  // (kyc.router.ts's POST /webhooks/didit handler) only durably enqueues
  // the already signature-verified, schema-validated body and acknowledges
  // fast; this consumes that job and runs the same fetch-decision-then-
  // apply-policy logic ProcessDiditWebhookService always has, unchanged.
  // Unlike the other event-triggered jobs above, this payload's own field
  // names are camelCase (traceId, not trace_id) — it isn't enqueued through
  // enqueueTransactionalJob's snake_case convention, since there's no other
  // write in the same transaction to bind the enqueue to; the payload
  // shape instead matches ProcessDiditWebhookService.execute's own
  // long-standing input type directly (see kyc.service.ts).
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
          "case timer job completed",
        );
      } catch (error) {
        logger.error(
          { err: error, trace_id: traceId, job: "provider_events.didit_webhook" },
          "case timer job failed",
        );
        throw error;
      }
    }
  });
}

logger.info("VistaBlox worker started");

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "worker shutting down");
  try {
    await boss.stop();
  } catch (error: unknown) {
    logger.error({ err: error }, "pg-boss shutdown failed");
  }
  await Promise.all([
    database.$disconnect(),
    authDatabase.end(),
    profileCacheClient?.isReady === true
      ? profileCacheClient.quit().catch(() => undefined)
      : Promise.resolve(),
  ]);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

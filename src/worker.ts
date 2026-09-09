import "dotenv/config";

import { PgBoss } from "pg-boss";
import { ulid } from "ulid";

import { loadEnvironment } from "./config/environment.js";
import { createPrismaClient } from "./infrastructure/database/prisma.js";
import { SmtpEmailSender } from "./infrastructure/email/smtp-email-sender.js";
import { createLogger } from "./infrastructure/logging/logger.js";
import {
  ExpireOverdueInformationRequestsService,
  SendApplicantResponseRemindersService,
} from "./modules/origination/application/case-timer.service.js";
import { TransitionCaseToPostIpoStructuringService } from "./modules/origination/application/post-ipo-structuring-handoff.service.js";
import { PrismaOriginationRepository } from "./modules/origination/repository/prisma-origination.repository.js";
import { PrismaOriginationKycProjectionRepository } from "./modules/origination/repository/prisma-origination-kyc-projection.repository.js";
import type { KycEligibilitySnapshot } from "./modules/identity/repository/kyc-eligibility-reader.js";
import { OpenOfferingForApprovedCaseService } from "./modules/offering/application/open-offering-for-approved-case.service.js";
import { ExpireUnfundedReservationsService } from "./modules/offering/application/expire-reservations.service.js";
import { PollOnrampTransactionsService } from "./modules/offering/application/poll-onramp-transactions.service.js";
import { CommitOfferingFinalizationService } from "./modules/offering/application/commit-offering-finalization.service.js";
import { SendReconfirmationRemindersService } from "./modules/offering/application/send-reconfirmation-reminders.service.js";
import { NotifyReconfirmationWindowOpenedService } from "./modules/offering/application/notify-reconfirmation-window-opened.service.js";
import { PrismaOfferingRepository } from "./modules/offering/repository/prisma-offering.repository.js";
import { PrismaOfferingKycProjectionRepository } from "./modules/offering/repository/prisma-offering-kyc-projection.repository.js";
import { PrismaInvestorProfileKycProjectionRepository } from "./modules/investor-profile/repository/prisma-investor-profile-kyc-projection.repository.js";
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

// Phase 7: origination's, offering's, and investor-profile's own local,
// event-driven copies of KycEligibility (docs/kyc-eligibility-read-model.md)
// -- PrismaKycRepository is gone from this file entirely now: neither this
// file's own jobs nor origination's/offering's repositories read
// identity.kyc_eligibility directly any more. Read side: getEligibilitySnapshot
// below, unchanged from each repository's own perspective (investor-profile's
// own repository reads this same projection, but is constructed in
// server.ts, not here -- this file only owns this projection's write side,
// same as it owns origination's/offering's). Write side: applyEvent/
// reconcile, wired into <domain>.kyc_eligibility_apply/
// <domain>.kyc_eligibility_reconcile further down -- investor-profile's own
// pair is this file's first background-job presence for that module.
const originationKycProjection = new PrismaOriginationKycProjectionRepository(database);
const offeringKycProjection = new PrismaOfferingKycProjectionRepository(database);
const investorProfileKycProjection = new PrismaInvestorProfileKycProjectionRepository(database);

const offeringRepository = new PrismaOfferingRepository(database, boss, offeringKycProjection);
const originationRepository = new PrismaOriginationRepository(database, boss, originationKycProjection);
const sendApplicantReminders = new SendApplicantResponseRemindersService(
  originationRepository,
  emailSender,
);
const expireOverdueRequests = new ExpireOverdueInformationRequestsService(originationRepository);
const transitionCaseToPostIpoStructuring = new TransitionCaseToPostIpoStructuringService(originationRepository);
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

// Shared by every identity.kyc_eligibility_changed subscriber below (Phase
// 7): the published payload is always a KycEligibilitySnapshot plus the
// trace_id publishTransactionalEvent injects (enqueue-job.ts) -- split them
// apart once here rather than at each of origination's/offering's/
// investor-profile's own apply handlers.
function parseEligibilityChangedEvent(data: unknown): {
  snapshot: KycEligibilitySnapshot;
  traceId: string;
} {
  const record = data as KycEligibilitySnapshot & { trace_id?: unknown };
  const { trace_id, ...snapshot } = record;
  return { snapshot, traceId: typeof trace_id === "string" ? trace_id : "unknown" };
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
// Only registered when Coinbase CDP credentials are configured — unlike
// every other job here, this one's sole dependency (the onramp REST client)
// is genuinely optional, matching how server.ts only wires reservation
// creation itself when the same credentials are present.
if (pollOnrampTransactions !== undefined) {
  await boss.createQueue("case_timers.reservation_onramp_poll");
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
// Phase 7: origination's own event-driven KYC eligibility projection --
// see docs/kyc-eligibility-read-model.md. _apply applies one
// identity.kyc_eligibility_changed event at a time (subscribed below);
// _reconcile is both the cold-start backfill and the ongoing staleness
// backstop for whatever _apply missed.
await boss.createQueue("origination.kyc_eligibility_apply");
await boss.createQueue("origination.kyc_eligibility_reconcile");
await boss.createQueue("offering.kyc_eligibility_apply");
await boss.createQueue("offering.kyc_eligibility_reconcile");
await boss.createQueue("investor_profile.kyc_eligibility_apply");
await boss.createQueue("investor_profile.kyc_eligibility_reconcile");
// subscribe is ON CONFLICT (event, name) DO UPDATE -- the same
// idempotent-on-every-start convention createQueue already establishes here,
// just pg-boss's own publish/subscribe primitive instead. Static ops config,
// not something that changes at runtime.
await boss.subscribe("identity.kyc_eligibility_changed", "origination.kyc_eligibility_apply");
await boss.subscribe("identity.kyc_eligibility_changed", "offering.kyc_eligibility_apply");
await boss.subscribe("identity.kyc_eligibility_changed", "investor_profile.kyc_eligibility_apply");

await boss.schedule("case_timers.applicant_reminders", "0 8 * * *", null, {
  tz: "UTC",
  ...RETRY_OPTIONS,
});
await boss.schedule("case_timers.response_window_expiry", "0 * * * *", null, {
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
// Hourly, matching maintenance.kyc_stuck_session_expiry's own "generous
// headroom" precedent -- origination has no read path where staleness
// touches money, unlike offering's own copy of this job just below.
await boss.schedule("origination.kyc_eligibility_reconcile", "0 * * * *", null, {
  tz: "UTC",
  ...RETRY_OPTIONS,
});
// Every 5 minutes, not hourly like origination's copy above: this is the
// one projection on CreateReservationService's path, where the
// degraded-case staleness bound (a stuck subscriber, falling back to this
// reconcile job) actually touches money -- see
// docs/kyc-eligibility-read-model.md's consistency-model discussion. Made
// affordable at this cadence by reconcile's own diff-then-write design
// (nearly all reads once a projection is in sync), not by anything specific
// to offering.
await boss.schedule("offering.kyc_eligibility_reconcile", "*/5 * * * *", null, {
  tz: "UTC",
  ...RETRY_OPTIONS,
});
// Hourly, same reasoning as origination's own copy above -- no read path
// here where staleness touches money the way offering's does.
await boss.schedule("investor_profile.kyc_eligibility_reconcile", "0 * * * *", null, {
  tz: "UTC",
  ...RETRY_OPTIONS,
});
// One immediate run of each at every worker start, in addition to their own
// schedules above -- cold-start backfill (an empty projection table)
// shouldn't have to wait for the first scheduled tick. Cheap on every other
// start too: reconcile is diff-then-write, so an already-synced table is
// nearly all reads.
await boss.send("origination.kyc_eligibility_reconcile", {}, RETRY_OPTIONS);
await boss.send("offering.kyc_eligibility_reconcile", {}, RETRY_OPTIONS);
await boss.send("investor_profile.kyc_eligibility_reconcile", {}, RETRY_OPTIONS);

await boss.work("case_timers.applicant_reminders", async () => {
  await runJob("case_timers.applicant_reminders", () => sendApplicantReminders.execute());
});
await boss.work("case_timers.response_window_expiry", async () => {
  await runJob("case_timers.response_window_expiry", (traceId) =>
    expireOverdueRequests.execute(traceId),
  );
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

// This job's trace_id is the originating write's own (the KYC service's),
// carried through publishTransactionalEvent -- not a freshly minted one,
// same reasoning as case_timers.pre_offering_open_handoff above.
await boss.work("origination.kyc_eligibility_apply", async (jobs) => {
  for (const job of jobs) {
    const { snapshot, traceId } = parseEligibilityChangedEvent(job.data);
    try {
      const summary = await originationKycProjection.applyEvent(snapshot);
      logger.info(
        { trace_id: traceId, job: "origination.kyc_eligibility_apply", ...summary },
        "case timer job completed",
      );
    } catch (error) {
      logger.error(
        { err: error, trace_id: traceId, job: "origination.kyc_eligibility_apply" },
        "case timer job failed",
      );
      throw error;
    }
  }
});
await boss.work("origination.kyc_eligibility_reconcile", async () => {
  await runJob("origination.kyc_eligibility_reconcile", () => originationKycProjection.reconcile());
});
await boss.work("offering.kyc_eligibility_apply", async (jobs) => {
  for (const job of jobs) {
    const { snapshot, traceId } = parseEligibilityChangedEvent(job.data);
    try {
      const summary = await offeringKycProjection.applyEvent(snapshot);
      logger.info(
        { trace_id: traceId, job: "offering.kyc_eligibility_apply", ...summary },
        "case timer job completed",
      );
    } catch (error) {
      logger.error(
        { err: error, trace_id: traceId, job: "offering.kyc_eligibility_apply" },
        "case timer job failed",
      );
      throw error;
    }
  }
});
await boss.work("offering.kyc_eligibility_reconcile", async () => {
  await runJob("offering.kyc_eligibility_reconcile", () => offeringKycProjection.reconcile());
});
await boss.work("investor_profile.kyc_eligibility_apply", async (jobs) => {
  for (const job of jobs) {
    const { snapshot, traceId } = parseEligibilityChangedEvent(job.data);
    try {
      const summary = await investorProfileKycProjection.applyEvent(snapshot);
      logger.info(
        { trace_id: traceId, job: "investor_profile.kyc_eligibility_apply", ...summary },
        "case timer job completed",
      );
    } catch (error) {
      logger.error(
        { err: error, trace_id: traceId, job: "investor_profile.kyc_eligibility_apply" },
        "case timer job failed",
      );
      throw error;
    }
  }
});
await boss.work("investor_profile.kyc_eligibility_reconcile", async () => {
  await runJob("investor_profile.kyc_eligibility_reconcile", () =>
    investorProfileKycProjection.reconcile(),
  );
});

logger.info("VistaBlox worker started");

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "worker shutting down");
  try {
    await boss.stop();
  } catch (error: unknown) {
    logger.error({ err: error }, "pg-boss shutdown failed");
  }
  await database.$disconnect();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

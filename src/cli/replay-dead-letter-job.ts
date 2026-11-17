/**
 * Replays one dead-lettered job (docs/dead-letter-jobs.md).
 *
 *   npm run jobs:replay-dead-letter -- --dead-letter-job-id <uuid>            (dry run)
 *   npm run jobs:replay-dead-letter -- --dead-letter-job-id <uuid> --confirm
 *
 * Run from a shell inside the worker or API container, where the container's
 * own environment is read through the normal loadEnvironment(). Fix the cause
 * of the failure first: a replay runs the same handler on the same payload.
 *
 * Exit codes: 0 replayed or dry run ok, 1 refused or failed, 2 bad arguments.
 */
import "dotenv/config";

import { PgBoss } from "pg-boss";

import { loadEnvironment } from "../config/environment.js";
import { createLogger } from "../infrastructure/logging/logger.js";
import { planDeadLetterReplay, replayDeadLetterJob } from "../shared/jobs/dead-letter-replay.js";
import { parseReplayDeadLetterJobArguments, REPLAY_DEAD_LETTER_JOB_USAGE } from "./replay-dead-letter-job-arguments.js";

const EXIT_REFUSED_OR_FAILED = 1;
const EXIT_USAGE = 2;

function print(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function printError(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(): Promise<number> {
  const parsed = parseReplayDeadLetterJobArguments(process.argv.slice(2));
  if (!parsed.ok) {
    printError(`Error: ${parsed.error}\n`);
    printError(REPLAY_DEAD_LETTER_JOB_USAGE);
    return EXIT_USAGE;
  }
  if (parsed.value.mode === "help") {
    print(REPLAY_DEAD_LETTER_JOB_USAGE);
    return 0;
  }
  const { mode, deadLetterJobId } = parsed.value;

  const environment = loadEnvironment();
  const logger = createLogger(environment.LOG_LEVEL, process.stderr);
  // No maintenance, cron or migration from this short-lived process; the
  // worker owns all three.
  const boss = new PgBoss({
    connectionString: environment.DATABASE_URL,
    supervise: false,
    schedule: false,
    migrate: false,
    createSchema: false,
  });
  boss.on("error", (error) => printError(`pg-boss: ${error.message}`));
  try {
    await boss.start();
    const plan = await planDeadLetterReplay(boss, deadLetterJobId);
    if (!plan.ok) {
      printError(`Refused (${plan.reason}): ${plan.detail}`);
      return EXIT_REFUSED_OR_FAILED;
    }
    print(mode === "confirm" ? "Replaying dead-lettered job:" : "Dry run, nothing changed. Would replay:");
    print(`  queue:              ${plan.queue}`);
    print(`  owner / tier:       ${plan.owner} / ${plan.tier}`);
    print(`  dead_letter_job_id: ${plan.deadLetterJobId}`);
    print(`  original job_id:    ${plan.sourceJobId ?? "unknown"}`);
    print(`  attempts so far:    ${plan.attempts ?? "unknown"}`);
    print(`  payload keys:       ${plan.payloadKeys.length === 0 ? "(none)" : plan.payloadKeys.join(", ")}`);
    print(`  replay job id:      ${plan.replayJobId}`);
    if (mode === "dry_run") {
      print();
      print("Re-run with --confirm to send it.");
      return 0;
    }
    const result = await replayDeadLetterJob(boss, plan);
    if (result.status === "already_replayed") {
      printError(`Refused (already_replayed): ${plan.queue} job ${result.jobId} already exists`);
      return EXIT_REFUSED_OR_FAILED;
    }
    logger.warn(
      {
        event: "job.dead_letter_replayed",
        severity: "warning",
        job: plan.queue,
        job_id: result.jobId,
        dead_letter_job_id: plan.deadLetterJobId,
        original_job_id: plan.sourceJobId,
        owner: plan.owner,
        tier: plan.tier,
      },
      "dead-lettered job replayed by operator",
    );
    print();
    print(`Sent as ${plan.queue} job ${result.jobId}. The worker picks it up on its next poll.`);
    return 0;
  } catch (error) {
    printError(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_REFUSED_OR_FAILED;
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
  }
}

process.exit(await main());

import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { createLogger } from "../src/infrastructure/logging/logger.js";
import { registerDeadLetterConsumer } from "../src/shared/jobs/dead-letter-consumer.js";
import {
  enqueueTransactionalJob,
  JOB_RETRY_OPTIONS,
  SCHEDULED_JOB_RETRY_OPTIONS,
} from "../src/shared/jobs/enqueue-job.js";
import { DEAD_LETTER_QUEUE, ensureDeadLetterQueue, ensureJobQueue } from "../src/shared/jobs/job-queues.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

const DEAD_LETTER_MESSAGE = "job dead-lettered after exhausting retries";
const TWO_HOURS = 2 * 60 * 60;

// OPS-01 / INTAKE-08 / F3: a job that keeps failing used to exhaust five
// retries in about a minute and then sit in the failed state with nothing
// watching it. These tests drive the real pg-boss against a pg-boss schema of
// their own (so the queues other test files create in the shared schema cannot
// interfere) and prove that the production queue options, retry profile and
// dead-letter consumer turn a persistently failing job into a dead-letter
// entry and one error-level log line.
describe.skipIf(databaseUrl === undefined)("job retries and dead-lettering PostgreSQL integration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const bossSchema = `pgboss_dlq_${suffix}`;
  const pool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const logLines: Array<Record<string, unknown>> = [];
  const logDestination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  // PgBoss's constructor eagerly validates its connection string, so it must
  // not be constructed at describe-body scope (the body runs even when skipIf
  // skips every test and databaseUrl is undefined).
  let boss: PgBoss;

  function deadLetterLogFor(jobId: string): Record<string, unknown> | undefined {
    return logLines.find((line) => line.msg === DEAD_LETTER_MESSAGE && line.job_id === jobId);
  }

  async function jobRows(
    queueName: string,
  ): Promise<
    Array<{
      id: string;
      state: string;
      retry_limit: number;
      retry_delay: number;
      retry_backoff: boolean;
      retry_delay_max: number | null;
      dead_letter: string | null;
      source_name: string | null;
      source_id: string | null;
      source_retry_count: number | null;
      data: Record<string, unknown>;
    }>
  > {
    const { rows } = await pool.query(
      `SELECT id, state, retry_limit, retry_delay, retry_backoff, retry_delay_max, dead_letter,
              source_name, source_id, source_retry_count, data
         FROM "${bossSchema}".job WHERE name = $1 ORDER BY created_on`,
      [queueName],
    );
    return rows;
  }

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: databaseUrl ?? "", schema: bossSchema });
    await boss.start();
    await ensureDeadLetterQueue(boss);
    await registerDeadLetterConsumer(boss, createLogger("info", logDestination));
  }, 30_000);

  afterAll(async () => {
    await boss.stop({ graceful: false });
    await pool.query(`DROP SCHEMA IF EXISTS "${bossSchema}" CASCADE`);
    await Promise.all([database.$disconnect(), pool.end()]);
  }, 30_000);

  it("brings a queue that already exists up to the current options, leaves jobs already enqueued as they were, and is safe to repeat", async () => {
    const queueName = `case_timers.legacy_${suffix}`;
    // The way every queue was created before: no options, and ON CONFLICT DO
    // NOTHING from then on.
    await boss.createQueue(queueName);
    expect(await boss.getQueue(queueName)).toMatchObject({
      retryLimit: 2,
      retryDelay: 0,
      retryBackoff: false,
      deadLetter: null,
    });
    const legacyJobId = await boss.send(queueName, { generation: "before" }, { retryLimit: 5, retryBackoff: true });

    await ensureJobQueue(boss, queueName, "event");
    await ensureJobQueue(boss, queueName, "event");

    expect(await boss.getQueue(queueName)).toMatchObject({
      retryLimit: JOB_RETRY_OPTIONS.retryLimit,
      retryDelay: JOB_RETRY_OPTIONS.retryDelay,
      retryBackoff: true,
      retryDelayMax: JOB_RETRY_OPTIONS.retryDelayMax,
      deadLetter: DEAD_LETTER_QUEUE,
    });
    const newJobId = await boss.send(queueName, { generation: "after" });
    const rows = await jobRows(queueName);
    // pg-boss copies retry and dead-letter settings onto each job when it is
    // sent, so a job queued before the update keeps the profile it was sent
    // with; only jobs sent afterwards pick the new options up.
    expect(rows.find((row) => row.id === legacyJobId)).toMatchObject({ retry_limit: 5, dead_letter: null });
    expect(rows.find((row) => row.id === newJobId)).toMatchObject({
      retry_limit: JOB_RETRY_OPTIONS.retryLimit,
      retry_delay: JOB_RETRY_OPTIONS.retryDelay,
      retry_backoff: true,
      retry_delay_max: JOB_RETRY_OPTIONS.retryDelayMax,
      dead_letter: DEAD_LETTER_QUEUE,
    });
  });

  it("keeps retrying an always-failing event job for over two hours on the production profile, then dead-letters it and logs it", async () => {
    const queueName = `provider_events.always_fails_${suffix}`;
    const traceId = `req_always_fails_${suffix}`;
    await ensureJobQueue(boss, queueName, "event");

    // The shared AD-145 enqueue path, inside a real Prisma transaction.
    const jobId = await database.$transaction((transaction) =>
      enqueueTransactionalJob(boss, transaction, queueName, { case_id: "case_always_fails" }, traceId),
    );
    expect(jobId).not.toBeNull();
    expect(deadLetterLogFor(jobId ?? "")).toBeUndefined();

    // Fail it on every attempt, pulling start_after forward each time so the
    // test does not wait out the real delays, and record the delay pg-boss
    // actually scheduled after each failure.
    const waits: number[] = [];
    for (let attempt = 1; attempt <= JOB_RETRY_OPTIONS.retryLimit + 1; attempt += 1) {
      await pool.query(`UPDATE "${bossSchema}".job SET start_after = now() WHERE name = $1 AND id = $2`, [
        queueName,
        jobId,
      ]);
      const fetched = await boss.fetch(queueName);
      expect(fetched.map((job) => job.id)).toEqual([jobId]);
      await boss.fail(queueName, jobId ?? "", new Error(`dependency down on attempt ${attempt}`));

      const { rows } = await pool.query<{ state: string; wait: string }>(
        `SELECT state, extract(epoch FROM (start_after - now())) AS wait
           FROM "${bossSchema}".job WHERE name = $1 AND id = $2`,
        [queueName, jobId],
      );
      if (attempt <= JOB_RETRY_OPTIONS.retryLimit) {
        expect(rows[0]?.state).toBe("retry");
        waits.push(Number(rows[0]?.wait));
      } else {
        expect(rows[0]?.state).toBe("failed");
      }
    }

    // The n-th retry waits min(max, delay * 2^(n-1) * (1 + random())) seconds.
    expect(waits).toHaveLength(JOB_RETRY_OPTIONS.retryLimit);
    waits.forEach((wait, index) => {
      const base = JOB_RETRY_OPTIONS.retryDelay * 2 ** index;
      expect(wait).toBeGreaterThanOrEqual(Math.min(JOB_RETRY_OPTIONS.retryDelayMax, base) - 2);
      expect(wait).toBeLessThanOrEqual(Math.min(JOB_RETRY_OPTIONS.retryDelayMax, 2 * base));
    });
    expect(waits.reduce((total, wait) => total + wait, 0)).toBeGreaterThan(TWO_HOURS);

    const deadLetterRows = (await jobRows(DEAD_LETTER_QUEUE)).filter((row) => row.source_id === jobId);
    expect(deadLetterRows).toHaveLength(1);
    expect(deadLetterRows[0]).toMatchObject({
      source_name: queueName,
      source_retry_count: JOB_RETRY_OPTIONS.retryLimit,
      data: { case_id: "case_always_fails", trace_id: traceId },
    });

    // The worker-side consumer picks it up and logs it for alerting.
    await vi.waitFor(() => expect(deadLetterLogFor(jobId ?? "")).toBeDefined(), { timeout: 20_000, interval: 250 });
    expect(deadLetterLogFor(jobId ?? "")).toMatchObject({
      level: 50,
      job: queueName,
      job_id: jobId,
      trace_id: traceId,
      retry_count: JOB_RETRY_OPTIONS.retryLimit,
      attempts: JOB_RETRY_OPTIONS.retryLimit + 1,
      last_error: `dependency down on attempt ${JOB_RETRY_OPTIONS.retryLimit + 1}`,
    });
    expect(logLines.filter((line) => line.msg === DEAD_LETTER_MESSAGE && line.job_id === jobId)).toHaveLength(1);
    // The payload stays in the dead-letter queue (completed, not deleted) for later replay.
    await vi.waitFor(
      async () => {
        const [row] = (await jobRows(DEAD_LETTER_QUEUE)).filter((candidate) => candidate.source_id === jobId);
        expect(row?.state).toBe("completed");
      },
      { timeout: 10_000, interval: 250 },
    );
  }, 60_000);

  it("dead-letters a job whose worker handler keeps throwing, routed by the queue's own configuration", async () => {
    const queueName = `case_timers.worker_throws_${suffix}`;
    const traceId = `req_worker_throws_${suffix}`;
    await ensureJobQueue(boss, queueName, "event");
    await boss.work(queueName, { pollingIntervalSeconds: 0.5 }, async () => {
      throw new Error("downstream is down");
    });

    // Only the delays are shortened; the dead-letter queue is the queue's.
    const jobId = await boss.send(queueName, { trace_id: traceId }, { retryLimit: 1, retryDelay: 1, retryBackoff: false });

    await vi.waitFor(() => expect(deadLetterLogFor(jobId ?? "")).toBeDefined(), { timeout: 30_000, interval: 250 });
    expect(deadLetterLogFor(jobId ?? "")).toMatchObject({
      level: 50,
      job: queueName,
      trace_id: traceId,
      retry_count: 1,
      attempts: 2,
      last_error: "downstream is down",
    });
    await boss.offWork(queueName);
  }, 60_000);

  it("leaves a dead-lettered job replayable with boss.retry on its source queue", async () => {
    const queueName = `case_timers.replay_${suffix}`;
    const traceId = `req_replay_${suffix}`;
    await ensureJobQueue(boss, queueName, "event");
    const jobId = await boss.send(queueName, { case_id: "case_replay", trace_id: traceId }, { retryLimit: 0 });
    await boss.fetch(queueName);
    await boss.fail(queueName, jobId ?? "", new Error("outage"));
    await vi.waitFor(() => expect(deadLetterLogFor(jobId ?? "")).toBeDefined(), { timeout: 20_000, interval: 250 });
    expect((await jobRows(queueName)).find((row) => row.id === jobId)?.state).toBe("failed");

    // The operator's replay: the original job, original payload, back in its own queue.
    // (pg-boss's CommandResponse type declares no fields; the result does carry `affected`.)
    expect(await boss.retry(queueName, jobId ?? "")).toMatchObject({ affected: 1 });
    const fetched = await boss.fetch<{ case_id: string; trace_id: string }>(queueName);
    expect(fetched.map((job) => ({ id: job.id, data: job.data }))).toEqual([
      { id: jobId, data: { case_id: "case_replay", trace_id: traceId } },
    ]);
    await boss.complete(queueName, jobId ?? "");
    expect((await jobRows(queueName)).find((row) => row.id === jobId)?.state).toBe("completed");
  }, 60_000);

  it("logs the cause of a job that pg-boss itself failed because its handler outlived expireInSeconds", async () => {
    const queueName = `case_timers.expires_${suffix}`;
    const traceId = `req_expires_${suffix}`;
    await ensureJobQueue(boss, queueName, "event");

    // A worker killed mid-job (a deploy, an OOM) leaves the job active until
    // pg-boss's supervisor expires it; the failure output pg-boss writes for
    // that is its own, not a thrown Error's.
    const jobId = await boss.send(queueName, { case_id: "case_expires", trace_id: traceId }, { retryLimit: 0, expireInSeconds: 1 });
    expect((await boss.fetch(queueName)).map((job) => job.id)).toEqual([jobId]);
    await pool.query(`UPDATE "${bossSchema}".job SET started_on = now() - interval '1 hour' WHERE name = $1 AND id = $2`, [
      queueName,
      jobId,
    ]);
    await boss.supervise(queueName);
    expect((await jobRows(queueName)).find((row) => row.id === jobId)?.state).toBe("failed");

    await vi.waitFor(() => expect(deadLetterLogFor(jobId ?? "")).toBeDefined(), { timeout: 20_000, interval: 250 });
    expect(deadLetterLogFor(jobId ?? "")).toMatchObject({
      level: 50,
      job: queueName,
      trace_id: traceId,
      retry_count: 0,
      attempts: 1,
      last_error: "job timed out",
    });
  }, 60_000);

  it("dead-letters a scheduled queue's job as well", async () => {
    const queueName = `case_timers.scheduled_${suffix}`;
    await ensureJobQueue(boss, queueName, "scheduled");

    // Retries are the scheduled profile's; retryLimit 0 only skips them.
    const jobId = await boss.send(queueName, null, { ...SCHEDULED_JOB_RETRY_OPTIONS, retryLimit: 0 });
    await boss.fetch(queueName);
    await boss.fail(queueName, jobId ?? "", new Error("scheduled run failed"));

    await vi.waitFor(() => expect(deadLetterLogFor(jobId ?? "")).toBeDefined(), { timeout: 20_000, interval: 250 });
    expect(deadLetterLogFor(jobId ?? "")).toMatchObject({
      job: queueName,
      trace_id: "unknown",
      attempts: 1,
      last_error: "scheduled run failed",
    });
  }, 60_000);
});

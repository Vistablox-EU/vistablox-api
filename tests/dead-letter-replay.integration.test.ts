import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planDeadLetterReplay, replayDeadLetterJob, replayJobIdFor } from "../src/shared/jobs/dead-letter-replay.js";
import { JOB_RETRY_OPTIONS } from "../src/shared/jobs/enqueue-job.js";
import { DEAD_LETTER_QUEUE, ensureDeadLetterQueue, ensureJobQueue } from "../src/shared/jobs/job-queues.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

const EVENT_QUEUE = "settlement.open_ipo_escrow_campaign";
const SCHEDULED_QUEUE = "settlement.finalize_ipo_escrow_campaigns";

// Issue #174: the replay CLI re-sends one dead-letter entry's payload to its
// source queue. These tests drive real pg-boss in a schema of their own, with
// no consumers, so every job stays where the test puts it.
describe.skipIf(databaseUrl === undefined)("dead-letter replay PostgreSQL integration", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const bossSchema = `pgboss_replay_${suffix}`;
  const pool = new Pool({ connectionString: databaseUrl });
  let boss: PgBoss;

  // Sends a job that dead-letters on its first failure, fails it, and returns
  // the dead-letter entry's id.
  async function deadLetter(queue: string, data: Record<string, unknown>): Promise<{ id: string; sourceId: string }> {
    const sourceId = await boss.send(queue, data, { retryLimit: 0, deadLetter: DEAD_LETTER_QUEUE });
    if (sourceId === null) throw new Error("send returned null");
    const [fetched] = await boss.fetch(queue);
    expect(fetched?.id).toBe(sourceId);
    await boss.fail(queue, sourceId, new Error("dependency down"));
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM "${bossSchema}".job WHERE name = $1 AND source_id = $2`,
      [DEAD_LETTER_QUEUE, sourceId],
    );
    expect(rows).toHaveLength(1);
    return { id: rows[0]?.id ?? "", sourceId };
  }

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: databaseUrl ?? "", schema: bossSchema });
    await boss.start();
    await ensureDeadLetterQueue(boss);
    await ensureJobQueue(boss, EVENT_QUEUE, "event");
    await ensureJobQueue(boss, SCHEDULED_QUEUE, "scheduled");
  }, 30_000);

  afterAll(async () => {
    await boss.stop({ graceful: false });
    await pool.query(`DROP SCHEMA IF EXISTS "${bossSchema}" CASCADE`);
    await pool.end();
  }, 30_000);

  it("plans a replay of an event job, sends the same payload once, and refuses a second replay", async () => {
    const data = { case_id: "case_replay_1", trace_id: "req_replay_1" };
    const entry = await deadLetter(EVENT_QUEUE, data);

    const plan = await planDeadLetterReplay(boss, entry.id);
    expect(plan).toEqual({
      ok: true,
      deadLetterJobId: entry.id,
      queue: EVENT_QUEUE,
      sourceJobId: entry.sourceId,
      owner: "settlement",
      tier: "tier_1",
      attempts: 1,
      replayJobId: replayJobIdFor(entry.id),
      payloadKeys: ["case_id", "trace_id"],
      data,
    });
    if (!plan.ok) throw new Error("expected a plan");

    expect(await replayDeadLetterJob(boss, plan)).toEqual({ status: "sent", jobId: plan.replayJobId });
    const replayed = await boss.getJobById(EVENT_QUEUE, plan.replayJobId);
    expect(replayed).toMatchObject({
      state: "created",
      data,
      retryLimit: JOB_RETRY_OPTIONS.retryLimit,
      deadLetter: DEAD_LETTER_QUEUE,
    });

    // A second send of the same plan (two operators racing) is a no-op.
    expect(await replayDeadLetterJob(boss, plan)).toEqual({ status: "already_replayed", jobId: plan.replayJobId });
    expect(await planDeadLetterReplay(boss, entry.id)).toMatchObject({ ok: false, reason: "already_replayed" });
    const { rows } = await pool.query(`SELECT 1 FROM "${bossSchema}".job WHERE name = $1 AND data->>'case_id' = $2`, [
      EVENT_QUEUE,
      "case_replay_1",
    ]);
    expect(rows).toHaveLength(2);
  });

  it("refuses a scheduled queue's entry", async () => {
    const entry = await deadLetter(SCHEDULED_QUEUE, {});
    expect(await planDeadLetterReplay(boss, entry.id)).toMatchObject({ ok: false, reason: "scheduled_queue" });
  });

  it("refuses a queue that is not in the ownership registry", async () => {
    const queue = `unregistered.queue_${suffix}`;
    await ensureJobQueue(boss, queue, "event");
    const entry = await deadLetter(queue, { case_id: "case_x" });
    expect(await planDeadLetterReplay(boss, entry.id)).toMatchObject({ ok: false, reason: "unknown_queue" });
  });

  it("refuses an id that is not a dead-letter entry", async () => {
    expect(await planDeadLetterReplay(boss, randomUUID())).toMatchObject({ ok: false, reason: "not_found" });
  });
});

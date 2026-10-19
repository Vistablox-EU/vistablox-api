import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

import { JOB_RETRY_OPTIONS, SCHEDULED_JOB_RETRY_OPTIONS } from "../src/shared/jobs/enqueue-job.js";
import { DEAD_LETTER_QUEUE, ensureDeadLetterQueue, ensureJobQueue } from "../src/shared/jobs/job-queues.js";

type Call = [method: "createQueue" | "updateQueue", name: string, options: unknown];

function fakeBoss(): { boss: PgBoss; calls: Call[] } {
  const calls: Call[] = [];
  const boss = {
    createQueue: vi.fn(async (name: string, options?: unknown) => {
      calls.push(["createQueue", name, options]);
    }),
    updateQueue: vi.fn(async (name: string, options?: unknown) => {
      calls.push(["updateQueue", name, options]);
    }),
  } as unknown as PgBoss;
  return { boss, calls };
}

describe("ensureDeadLetterQueue", () => {
  it("creates the dead-letter queue and then updates it, keeping failed payloads for 30 days", async () => {
    const { boss, calls } = fakeBoss();

    await ensureDeadLetterQueue(boss);

    const options = { retentionSeconds: 2_592_000, deleteAfterSeconds: 2_592_000 };
    expect(calls).toEqual([
      ["createQueue", DEAD_LETTER_QUEUE, options],
      ["updateQueue", DEAD_LETTER_QUEUE, options],
    ]);
  });

  it("does not give the dead-letter queue a dead-letter queue of its own", async () => {
    const { boss, calls } = fakeBoss();

    await ensureDeadLetterQueue(boss);

    for (const [, , options] of calls) {
      expect(options).not.toHaveProperty("deadLetter");
    }
  });
});

describe("ensureJobQueue", () => {
  it("applies the event retry profile and the dead-letter queue to an event queue, on create and again on update", async () => {
    const { boss, calls } = fakeBoss();

    await ensureJobQueue(boss, "provider_events.didit_webhook", "event");

    const options = { ...JOB_RETRY_OPTIONS, deadLetter: DEAD_LETTER_QUEUE };
    expect(calls).toEqual([
      ["createQueue", "provider_events.didit_webhook", options],
      // createQueue is ON CONFLICT DO NOTHING: only updateQueue reaches a
      // queue that already exists from before this configuration shipped.
      ["updateQueue", "provider_events.didit_webhook", options],
    ]);
  });

  it("applies the short scheduled profile and the dead-letter queue to a scheduled queue", async () => {
    const { boss, calls } = fakeBoss();

    await ensureJobQueue(boss, "case_timers.applicant_reminders", "scheduled");

    const options = { ...SCHEDULED_JOB_RETRY_OPTIONS, deadLetter: DEAD_LETTER_QUEUE };
    expect(calls).toEqual([
      ["createQueue", "case_timers.applicant_reminders", options],
      ["updateQueue", "case_timers.applicant_reminders", options],
    ]);
  });
});

function sourceOf(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
}

function queueKinds(source: string, bossVariable: string): Map<string, string> {
  const pattern = new RegExp(`ensureJobQueue\\(${bossVariable}, "([^"]+)", "(event|scheduled)"\\)`, "g");
  return new Map([...source.matchAll(pattern)].map((match) => [match[1] ?? "", match[2] ?? ""]));
}

// src/server.ts and src/worker.ts are start-up scripts that cannot be imported
// into a test, so what they wire up is checked from their source. Their
// behaviour against a real database was also run by hand (see the commit
// message).
describe("queue creation at startup", () => {
  // Both entry points create queues, and pg-boss's createQueue cannot change
  // a queue that already exists. A queue created through a raw createQueue
  // call would silently skip the dead-letter queue and retry profile on every
  // existing deployment.
  it.each(["src/server.ts", "src/worker.ts"])("%s creates queues only through ensureJobQueue", (file) => {
    const source = sourceOf(file);

    // Booleans, so a failure does not dump the whole source file.
    expect(/\.createQueue\(/.test(source)).toBe(false);
    expect(/ensureDeadLetterQueue\(/.test(source)).toBe(true);
    expect(/ensureJobQueue\(/.test(source)).toBe(true);
  });

  // createQueue with a deadLetter option fails with "Queue maintenance.dead_letter
  // does not exist" when the dead-letter queue is not there yet (a fresh
  // database), which would stop the API and the worker from starting; and a
  // consumer registered before the queue exists makes pg-boss emit an error
  // event on every poll. Existing databases already have the queue, so only
  // a fresh one would show it.
  it.each(["src/server.ts", "src/worker.ts"])("%s creates the dead-letter queue before any job queue", (file) => {
    const source = sourceOf(file);
    const deadLetter = source.search(/ensureDeadLetterQueue\(\w+\)/);
    const firstJobQueue = source.search(/ensureJobQueue\(/);

    expect(deadLetter).toBeGreaterThan(-1);
    expect(firstJobQueue).toBeGreaterThan(-1);
    expect(deadLetter).toBeLessThan(firstJobQueue);
  });

  it("the worker starts consuming the dead-letter queue only after creating it", () => {
    const source = sourceOf("src/worker.ts");
    const created = source.indexOf("await ensureDeadLetterQueue(boss);");
    const consumed = source.indexOf("await registerDeadLetterConsumer(boss, logger);");

    expect(created).toBeGreaterThan(-1);
    expect(consumed).toBeGreaterThan(created);
  });

  it("the worker declares a cron-scheduled queue as scheduled and a one-shot queue as event", () => {
    const source = sourceOf("src/worker.ts");
    const kinds = queueKinds(source, "boss");
    const scheduled = [...source.matchAll(/boss\.schedule\("([^"]+)"/g)].map((match) => match[1] ?? "");

    expect(scheduled.length).toBeGreaterThan(0);
    // A cron queue on the long event profile would stack retry runs behind a
    // failing every-minute job; a one-shot queue on the short scheduled
    // profile would give up on a Didit webhook after about a minute.
    for (const name of scheduled) expect([name, kinds.get(name)]).toEqual([name, "scheduled"]);
    for (const [name, kind] of kinds) {
      if (kind === "scheduled") expect(scheduled).toContain(name);
    }
    expect([...kinds].filter(([, kind]) => kind === "event").map(([name]) => name).sort()).toEqual([
      "case_timers.offering_reconfirmation_window_opened",
      "case_timers.post_ipo_structuring_handoff",
      "case_timers.pre_offering_open_handoff",
      "provider_events.didit_webhook",
      "settlement.open_ipo_escrow_campaign",
    ]);
  });

  it("every queue the worker consumes is one it creates", () => {
    const source = sourceOf("src/worker.ts");
    const kinds = queueKinds(source, "boss");
    const consumed = [...source.matchAll(/boss\.work\("([^"]+)"/g)].map((match) => match[1] ?? "");

    expect(consumed.length).toBeGreaterThan(0);
    for (const name of consumed) expect([name, kinds.has(name)]).toEqual([name, true]);
  });

  it("the API creates the queues it sends into, only as event queues, each with the same kind the worker gives it", () => {
    const serverKinds = queueKinds(sourceOf("src/server.ts"), "jobQueue");
    const workerKinds = queueKinds(sourceOf("src/worker.ts"), "boss");

    // The queues the API process enqueues into: PrismaKycRepository.enqueueDiditWebhookProcessing,
    // PrismaIntakeRepository (the offering-open handoff) and PrismaOfferingRepository
    // (publishFinalOfferingTerms: the reconfirmation notification and the
    // post-IPO handoff). Creating them here is what lets a send() succeed
    // when the API starts before the worker on a fresh deploy, and it is the
    // API process's only way to apply the retry and dead-letter settings.
    // settlement.open_ipo_escrow_campaign is enqueued from inside the worker
    // (the offering-open handoff's own transaction), so the worker creates it.
    expect([...serverKinds.keys()].sort()).toEqual([
      "case_timers.offering_reconfirmation_window_opened",
      "case_timers.post_ipo_structuring_handoff",
      "case_timers.pre_offering_open_handoff",
      "provider_events.didit_webhook",
    ]);
    // Two processes configuring one queue differently would undo each
    // other's settings on every start.
    for (const [name, kind] of serverKinds) expect([name, kind, workerKinds.get(name)]).toEqual([name, "event", "event"]);
  });
});

describe("worker retry and dead-letter wiring", () => {
  it("schedules every cron job with the scheduled retry profile, never the event one", () => {
    const source = sourceOf("src/worker.ts");
    const scheduleCalls = source.match(/boss\.schedule\(/g)?.length ?? 0;
    const retrySpreads = source.match(/\.\.\.RETRY_OPTIONS/g)?.length ?? 0;

    expect(scheduleCalls).toBeGreaterThan(0);
    expect(retrySpreads).toBe(scheduleCalls);
    expect(/const RETRY_OPTIONS = SCHEDULED_JOB_RETRY_OPTIONS;/.test(source)).toBe(true);
    expect(/\bJOB_RETRY_OPTIONS\b/.test(source.replaceAll("SCHEDULED_JOB_RETRY_OPTIONS", ""))).toBe(false);
  });

  it("consumes the dead-letter queue", () => {
    expect(/await registerDeadLetterConsumer\(boss, logger\);/.test(sourceOf("src/worker.ts"))).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ONRAMP_LATE_EVIDENCE_ALERT_JOB } from "../src/modules/offering/application/check-onramp-late-evidence.service.js";
import { JOB_QUEUE_OWNERSHIP } from "../src/shared/jobs/job-ownership.js";
import { withoutComments } from "./support/without-comments.js";

// src/worker.ts, src/server.ts and src/app.ts are start-up scripts and wiring
// that cannot be imported into a test, so what they connect is checked from
// their source, the way tests/coinbase-onramp-webhook-wiring.test.ts does.
// What nothing else covers is that the late-evidence pieces are connected at
// all: without the handler the poll and the webhook job only log a late
// success; without the job the standing alert never fires; without the mount
// the staff list answers 404. tsc notices none of them.
function load(path: string): { code: string; flat: string } {
  const code = withoutComments(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
  return { code, flat: code.replace(/\s+/g, " ") };
}

const worker = load("../src/worker.ts");
const server = load("../src/server.ts");
const app = load("../src/app.ts");

const queue = "maintenance.onramp_late_evidence_alert";

describe("late onramp evidence wiring in the worker", () => {
  it("gives the poller, and so the webhook job that runs on it, the handler that writes the entry", () => {
    expect(worker.flat).toContain(
      "const onrampLateEvidenceRepository = new PrismaOnrampLateEvidenceRepository(database);",
    );
    expect(worker.flat).toContain(
      "const recordOnrampLateEvidence = new RecordOnrampLateEvidenceService(onrampLateEvidenceRepository, logger);",
    );
    expect(worker.flat).toContain(
      "new PollOnrampTransactionsService(offeringRepository, coinbaseCdpClient, logger, undefined, recordOnrampLateEvidence);",
    );
  });

  it("creates the queue as a scheduled one, schedules it hourly, and consumes it", () => {
    expect(worker.flat).toContain(`await ensureJobQueue(boss, "${queue}", "scheduled");`);
    expect(worker.flat).toContain(`await boss.schedule("${queue}", "0 * * * *", null, { tz: "UTC", ...RETRY_OPTIONS, });`);
    expect(worker.code).toContain(`boss.work("${queue}"`);
  });

  it("does not tie the alert to the Coinbase credentials: it reads the database only", () => {
    const check = worker.flat.indexOf("const checkOnrampLateEvidence = ");
    expect(check).toBeGreaterThan(-1);
    expect(worker.flat.slice(check, worker.flat.indexOf(";", check))).toBe(
      "const checkOnrampLateEvidence = new CheckOnrampLateEvidenceService(onrampLateEvidenceRepository, logger)",
    );
    // Each call starts at column 0: not inside an `if (pollOnrampTransactions !== undefined)`
    // or any other guard, which the worker indents.
    for (const call of ["await ensureJobQueue(boss, ", "await boss.schedule(", "await boss.work("]) {
      expect(worker.code).toContain(`\n${call}"${queue}"`);
    }
  });

  it("runs the check through runJob and sets the gauge from what it counted", () => {
    const start = worker.code.indexOf(`boss.work("${queue}"`);
    expect(start).toBeGreaterThan(-1);
    const end = worker.code.indexOf("\n});", start);
    const handler = worker.code.slice(start, end).replace(/\s+/g, " ");
    expect(handler).toContain(`await runJob("${queue}"`);
    expect(handler).toContain("await checkOnrampLateEvidence.execute(traceId);");
    expect(handler).toContain('metrics.set("vistablox_worker_onramp_late_evidence_unreviewed", summary.unreviewed);');
    expect(handler).toContain("return summary;");
  });

  it("uses, in the log line, the same job name the worker schedules", () => {
    expect(ONRAMP_LATE_EVIDENCE_ALERT_JOB).toBe(queue);
  });

  it("registers the queue in the job-ownership table as a tier_1 scheduled payments queue (it reads the money schema)", () => {
    expect(JOB_QUEUE_OWNERSHIP[queue]).toEqual({ kind: "scheduled", owner: "payments", tier: "tier_1" });
  });
});

describe("late onramp evidence wiring in the API", () => {
  it("builds the staff repository over the database and passes it to createApp", () => {
    expect(server.flat).toContain(
      "onrampLateEvidence: { repository: new PrismaOnrampLateEvidenceRepository(database) },",
    );
  });

  it("mounts the staff router under the offerings prefix, ahead of the offering-operations router that owns /:offering_id", () => {
    const mount = app.code.indexOf('"/internal/v1/offerings/onramp-late-evidence"');
    const operations = app.code.indexOf('"/internal/v1/offerings",');
    expect(mount).toBeGreaterThan(-1);
    expect(operations).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(operations);
  });
});

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  CheckOnrampLateEvidenceService,
  ONRAMP_LATE_EVIDENCE_ALERT_JOB,
} from "../src/modules/offering/application/check-onramp-late-evidence.service.js";
import type { OnrampLateEvidenceSnapshot } from "../src/modules/offering/domain/onramp-late-evidence-alert.policy.js";
import type { OnrampLateEvidenceAlertSource } from "../src/modules/offering/repository/onramp-late-evidence.repository.js";

const now = new Date("2026-11-17T12:00:00.000Z");

function setup(snapshot: OnrampLateEvidenceSnapshot) {
  const source: OnrampLateEvidenceAlertSource = { unreviewedLateEvidenceSnapshot: vi.fn().mockResolvedValue(snapshot) };
  const lines: Array<Record<string, unknown> & { level: number; msg: string }> = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
  return { service: new CheckOnrampLateEvidenceService(source, logger, () => now), source, lines };
}

describe("CheckOnrampLateEvidenceService", () => {
  it("logs nothing and acts on nothing while no entry is unreviewed", async () => {
    const { service, lines } = setup({ unreviewedCount: 0, oldestObservedAt: null, oldestEvidenceIds: [] });

    expect(await service.execute("trace_01")).toEqual({ checked: 0, acted: 0, unreviewed: 0 });
    expect(lines).toEqual([]);
  });

  it("logs one warn line with the stable event, the severity, the job, the trace and counts and ids only", async () => {
    const { service, lines } = setup({
      unreviewedCount: 2,
      oldestObservedAt: new Date("2026-11-17T10:00:00.000Z"),
      oldestEvidenceIds: ["onramp_late_evidence_01", "onramp_late_evidence_02"],
    });

    const summary = await service.execute("trace_01");

    expect(summary).toEqual({ checked: 2, acted: 1, unreviewed: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 40,
      event: "offering.onramp_late_evidence_unreviewed",
      severity: "warn",
      job: "maintenance.onramp_late_evidence_alert",
      trace_id: "trace_01",
      unreviewed_count: 2,
      oldest_unreviewed_age_seconds: 7200,
      evidence_ids: ["onramp_late_evidence_01", "onramp_late_evidence_02"],
      evidence_ids_listed: 2,
    });
  });

  it("is level-triggered: every run raises it again while the entry stays unreviewed, and never at error level", async () => {
    const { service, lines } = setup({
      unreviewedCount: 1,
      oldestObservedAt: new Date("2026-11-17T11:00:00.000Z"),
      oldestEvidenceIds: ["onramp_late_evidence_01"],
    });

    await service.execute("trace_01");
    await service.execute("trace_02");
    await service.execute("trace_03");

    expect(lines.map((line) => [line.event, line.level, line.trace_id])).toEqual([
      ["offering.onramp_late_evidence_unreviewed", 40, "trace_01"],
      ["offering.onramp_late_evidence_unreviewed", 40, "trace_02"],
      ["offering.onramp_late_evidence_unreviewed", 40, "trace_03"],
    ]);
  });

  it("names the job the worker schedules", () => {
    expect(ONRAMP_LATE_EVIDENCE_ALERT_JOB).toBe("maintenance.onramp_late_evidence_alert");
  });

  it("lets a failing read fail the run, so pg-boss retries it and a persistent failure dead-letters", async () => {
    const source: OnrampLateEvidenceAlertSource = {
      unreviewedLateEvidenceSnapshot: vi.fn().mockRejectedValue(new Error("database unavailable")),
    };
    const service = new CheckOnrampLateEvidenceService(source, pino({ level: "silent" }), () => now);

    await expect(service.execute("trace_01")).rejects.toThrow("database unavailable");
  });
});

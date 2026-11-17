import { describe, expect, it } from "vitest";

import {
  MAX_ALERT_EVIDENCE_IDS,
  ONRAMP_LATE_EVIDENCE_ALERT_EVENTS,
  evaluateOnrampLateEvidence,
} from "../src/modules/offering/domain/onramp-late-evidence-alert.policy.js";
import {
  ONRAMP_LATE_EVIDENCE_STATES,
  classifyLateOnrampEvidence,
  type OnrampLateEvidenceReason,
} from "../src/modules/offering/domain/onramp-late-evidence.policy.js";

type Row = {
  label: string;
  stage: string;
  succeeded: boolean;
  expected: OnrampLateEvidenceReason | null;
};

// What the single recording method's other_stage outcome turns into, row by
// row (AD-288, decided 2026-11-17): a success for a reservation that has left
// 'initiated' is listed, with the reason its stage reads as; a failure moved no
// money and is not; an initiated reservation is not late at all.
const rows: Row[] = [
  { label: "a success on a lapsed reservation", stage: "lapsed", succeeded: true, expected: "reservation_lapsed" },
  { label: "a success on a cancelled reservation", stage: "cancelled", succeeded: true, expected: "reservation_cancelled" },
  { label: "a success while awaiting reconfirmation (already funded)", stage: "awaiting_reconfirmation", succeeded: true, expected: "reservation_funded_already" },
  { label: "a success on a reconfirmed reservation (already funded)", stage: "reconfirmed", succeeded: true, expected: "reservation_funded_already" },
  { label: "a success on a finalized reservation (already funded)", stage: "finalized", succeeded: true, expected: "reservation_funded_already" },
  { label: "a success at a stage this code does not know is still listed", stage: "some_future_stage", succeeded: true, expected: "reservation_other_stage" },

  { label: "a failed attempt on a lapsed reservation moved no money", stage: "lapsed", succeeded: false, expected: null },
  { label: "a failed attempt on a cancelled reservation moved no money", stage: "cancelled", succeeded: false, expected: null },
  { label: "a failed attempt on a finalized reservation moved no money", stage: "finalized", succeeded: false, expected: null },
  { label: "a failed attempt at an unknown stage moved no money", stage: "some_future_stage", succeeded: false, expected: null },

  { label: "a success on an initiated reservation is not late: it is recorded as money", stage: "initiated", succeeded: true, expected: null },
  { label: "a failure on an initiated reservation is not late either", stage: "initiated", succeeded: false, expected: null },
];

describe("classifyLateOnrampEvidence", () => {
  it.each(rows)("$label", ({ stage, succeeded, expected }) => {
    expect(classifyLateOnrampEvidence({ reservationStage: stage, transactionSucceeded: succeeded })).toBe(expected);
  });

  it("never classifies anything as a hold, a reinstatement or a refund", () => {
    const reasons = new Set(
      rows.map((row) => classifyLateOnrampEvidence({ reservationStage: row.stage, transactionSucceeded: row.succeeded })),
    );
    for (const reason of reasons) {
      if (reason !== null) expect(reason).toMatch(/^reservation_(lapsed|cancelled|funded_already|other_stage)$/);
    }
  });

  it("lists the two states the recording method would have written, and no other", () => {
    expect([...ONRAMP_LATE_EVIDENCE_STATES]).toEqual(["eurc_reserved", "purchase_failed"]);
  });
});

describe("evaluateOnrampLateEvidence (the standing alert)", () => {
  const now = new Date("2026-11-17T12:00:00.000Z");

  it("raises nothing while every entry is reviewed, and ends when the last one is", () => {
    expect(evaluateOnrampLateEvidence({ unreviewedCount: 0, oldestObservedAt: null, oldestEvidenceIds: [] }, now)).toEqual([]);
  });

  it("raises one stable warn event, level-triggered, for as long as one entry is unreviewed", () => {
    const snapshot = {
      unreviewedCount: 1,
      oldestObservedAt: new Date("2026-11-17T11:00:00.000Z"),
      oldestEvidenceIds: ["onramp_late_evidence_01"],
    };

    const first = evaluateOnrampLateEvidence(snapshot, now);
    // The same snapshot an hour later raises it again: nothing is remembered between checks.
    const later = evaluateOnrampLateEvidence(snapshot, new Date(now.getTime() + 3_600_000));

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      event: "offering.onramp_late_evidence_unreviewed",
      severity: "warn",
      details: {
        unreviewed_count: 1,
        oldest_unreviewed_age_seconds: 3600,
        evidence_ids: ["onramp_late_evidence_01"],
        evidence_ids_listed: 1,
      },
    });
    expect(later).toHaveLength(1);
    expect(later[0]?.details).toMatchObject({ oldest_unreviewed_age_seconds: 7200 });
  });

  it("keeps the event name stable, because an alert rule keys on it", () => {
    expect(ONRAMP_LATE_EVIDENCE_ALERT_EVENTS).toEqual({ unreviewed: "offering.onramp_late_evidence_unreviewed" });
  });

  it("is always a warn, whatever the count or the age", () => {
    for (const unreviewedCount of [1, 2, 50, 10_000]) {
      const alerts = evaluateOnrampLateEvidence(
        { unreviewedCount, oldestObservedAt: new Date("2026-01-01T00:00:00.000Z"), oldestEvidenceIds: ["a"] },
        now,
      );
      expect(alerts.map((alert) => alert.severity)).toEqual(["warn"]);
    }
  });

  it("lists at most MAX_ALERT_EVIDENCE_IDS ids but always says how many there are", () => {
    const ids = Array.from({ length: MAX_ALERT_EVIDENCE_IDS + 5 }, (_unused, index) => `onramp_late_evidence_${index}`);

    const [alert] = evaluateOnrampLateEvidence(
      { unreviewedCount: 120, oldestObservedAt: new Date("2026-11-17T00:00:00.000Z"), oldestEvidenceIds: ids },
      now,
    );

    expect(alert?.details.unreviewed_count).toBe(120);
    expect(alert?.details.evidence_ids).toEqual(ids.slice(0, MAX_ALERT_EVIDENCE_IDS));
    expect(alert?.details.evidence_ids_listed).toBe(MAX_ALERT_EVIDENCE_IDS);
  });

  it("never reports a negative age when the clock is behind the entry", () => {
    const [alert] = evaluateOnrampLateEvidence(
      { unreviewedCount: 1, oldestObservedAt: new Date("2026-11-17T12:00:05.000Z"), oldestEvidenceIds: ["a"] },
      now,
    );
    expect(alert?.details.oldest_unreviewed_age_seconds).toBe(0);
  });

  it("carries counts and ids only: no address, hash, amount or asset can be in the details", () => {
    const [alert] = evaluateOnrampLateEvidence(
      { unreviewedCount: 3, oldestObservedAt: new Date("2026-11-17T08:00:00.000Z"), oldestEvidenceIds: ["a", "b", "c"] },
      now,
    );
    expect(Object.keys(alert?.details ?? {}).sort()).toEqual([
      "evidence_ids",
      "evidence_ids_listed",
      "oldest_unreviewed_age_seconds",
      "unreviewed_count",
    ]);
    for (const value of Object.values(alert?.details ?? {})) {
      expect(typeof value === "number" || Array.isArray(value)).toBe(true);
    }
  });
});

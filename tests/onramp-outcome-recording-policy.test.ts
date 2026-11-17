import { describe, expect, it } from "vitest";

import {
  decideOnrampRecording,
  ONRAMP_AWAITING_CAPITAL_STATES,
  recordedAtAfterLatest,
  type OnrampRecordingDecision,
} from "../src/modules/offering/domain/onramp-outcome-recording.policy.js";

type Row = {
  label: string;
  stage: string;
  latest: string | null;
  recorded: boolean;
  expected: OnrampRecordingDecision;
};

// The guard matrix of the one onramp recording method, written out row by row
// so a change to the order of the checks shows up as a failing row rather than
// as a recomputed expectation.
const rows: Row[] = [
  // An initiated reservation waiting on its purchase is the only place a row is written.
  { label: "initiated, pending, outcome new", stage: "initiated", latest: "eurc_purchase_pending", recorded: false, expected: "record" },
  { label: "initiated, failed attempt, outcome new (a retry's result)", stage: "initiated", latest: "purchase_failed", recorded: false, expected: "record" },

  // Dedupe per provider transaction and state: nothing is written twice.
  { label: "initiated, pending, outcome already on file (a retry's pending event came after it)", stage: "initiated", latest: "eurc_purchase_pending", recorded: true, expected: "duplicate" },
  { label: "initiated, failed, same failure again (the poll lists a failed reservation every minute)", stage: "initiated", latest: "purchase_failed", recorded: true, expected: "duplicate" },
  { label: "initiated, funded, same funding again (webhook after the poll)", stage: "initiated", latest: "eurc_reserved", recorded: true, expected: "duplicate" },

  // A funded latest event is never written over, by anything.
  { label: "initiated, funded, an unfunded event (#201's guard)", stage: "initiated", latest: "eurc_reserved", recorded: false, expected: "already_funded" },
  { label: "initiated, reconfirmation_pending is funded too", stage: "initiated", latest: "reconfirmation_pending", recorded: false, expected: "already_funded" },
  { label: "initiated, eurc_finalized is funded too", stage: "initiated", latest: "eurc_finalized", recorded: false, expected: "already_funded" },

  // Not waiting on Coinbase at all.
  { label: "initiated, no money event yet", stage: "initiated", latest: null, recorded: false, expected: "not_awaiting_purchase" },
  { label: "initiated, only the creation event", stage: "initiated", latest: "initiated", recorded: false, expected: "not_awaiting_purchase" },
  { label: "initiated, a state a later stage wrote", stage: "initiated", latest: "refund_pending", recorded: false, expected: "not_awaiting_purchase" },

  // A reservation that left 'initiated' is late evidence, whatever its money looked like.
  { label: "lapsed while still pending", stage: "lapsed", latest: "eurc_purchase_pending", recorded: false, expected: "other_stage" },
  { label: "lapsed after a failed attempt", stage: "lapsed", latest: "purchase_failed", recorded: false, expected: "other_stage" },
  { label: "cancelled", stage: "cancelled", latest: "eurc_purchase_pending", recorded: false, expected: "other_stage" },
  { label: "cancelled with no money event", stage: "cancelled", latest: null, recorded: false, expected: "other_stage" },
  { label: "funded and awaiting reconfirmation, another transaction", stage: "awaiting_reconfirmation", latest: "eurc_reserved", recorded: false, expected: "other_stage" },
  { label: "reconfirmed", stage: "reconfirmed", latest: "reconfirmation_pending", recorded: false, expected: "other_stage" },
  { label: "finalized", stage: "finalized", latest: "eurc_finalized", recorded: false, expected: "other_stage" },

  // Evidence already on file is a duplicate even after the reservation moved on,
  // so it never reads as late evidence.
  { label: "funded, then awaiting reconfirmation, the funding transaction delivered again", stage: "awaiting_reconfirmation", latest: "eurc_reserved", recorded: true, expected: "duplicate" },
  { label: "lapsed after the failure was recorded, the same failure again", stage: "lapsed", latest: "purchase_failed", recorded: true, expected: "duplicate" },
];

describe("decideOnrampRecording", () => {
  it.each(rows)("$label -> $expected", ({ stage, latest, recorded, expected }) => {
    expect(
      decideOnrampRecording({
        reservationStage: stage,
        latestCapitalState: latest,
        outcomeAlreadyRecorded: recorded,
      }),
    ).toBe(expected);
  });

  it("writes only for the two awaiting states", () => {
    expect([...ONRAMP_AWAITING_CAPITAL_STATES]).toEqual(["eurc_purchase_pending", "purchase_failed"]);
    const written = rows.filter((row) => row.expected === "record");
    expect(written.map((row) => row.latest).sort()).toEqual(["eurc_purchase_pending", "purchase_failed"]);
    expect(written.every((row) => row.stage === "initiated" && !row.recorded)).toBe(true);
  });
});

describe("recordedAtAfterLatest", () => {
  const latest = new Date("2026-11-17T12:00:05.000Z");
  const cases: Array<{ label: string; requested: string; latest: Date | null; expected: string }> = [
    { label: "no event on file: the caller's time", requested: "2026-11-17T12:00:01.000Z", latest: null, expected: "2026-11-17T12:00:01.000Z" },
    { label: "later than the latest: the caller's time", requested: "2026-11-17T12:00:09.000Z", latest, expected: "2026-11-17T12:00:09.000Z" },
    { label: "one millisecond after the latest: the caller's time", requested: "2026-11-17T12:00:05.001Z", latest, expected: "2026-11-17T12:00:05.001Z" },
    { label: "the same instant as the latest: one millisecond after it (the id would decide otherwise)", requested: "2026-11-17T12:00:05.000Z", latest, expected: "2026-11-17T12:00:05.001Z" },
    { label: "earlier than the latest (a reconciler that read its clock before queueing): one millisecond after the latest", requested: "2026-11-17T12:00:02.000Z", latest, expected: "2026-11-17T12:00:05.001Z" },
    { label: "a clock far behind the latest event's (a skewed API stamped it): one millisecond after the latest", requested: "2026-11-17T09:00:00.000Z", latest, expected: "2026-11-17T12:00:05.001Z" },
  ];

  it.each(cases)("$label", ({ requested, latest: latestRecordedAt, expected }) => {
    expect(recordedAtAfterLatest(new Date(requested), latestRecordedAt).toISOString()).toBe(expected);
  });

  it("never returns a time at or before the latest event, and leaves its inputs alone", () => {
    const requested = new Date("2026-11-17T11:00:00.000Z");
    const before = [requested.getTime(), latest.getTime()];
    const result = recordedAtAfterLatest(requested, latest);
    expect(result.getTime()).toBeGreaterThan(latest.getTime());
    expect([requested.getTime(), latest.getTime()]).toEqual(before);
  });
});

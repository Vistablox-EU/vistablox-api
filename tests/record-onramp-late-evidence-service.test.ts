import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { RecordOnrampLateEvidenceService } from "../src/modules/offering/application/record-onramp-late-evidence.service.js";
import type { OtherStageOnrampOutcome } from "../src/modules/offering/application/other-stage-onramp-outcome.js";
import type {
  OnrampLateEvidenceRecorder,
  RecordOnrampLateEvidenceInput,
} from "../src/modules/offering/repository/onramp-late-evidence.repository.js";

const wallet = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const hash = "0xabc123def456";

function outcome(overrides: Partial<OtherStageOnrampOutcome> = {}): OtherStageOnrampOutcome {
  return {
    reservationId: "reservation_01",
    reservationStage: "lapsed",
    latestCapitalState: "eurc_purchase_pending",
    providerTransactionId: "txn_late",
    txHash: hash,
    destinationWallet: wallet,
    amount: "950.000000",
    asset: "EURC",
    state: "eurc_reserved",
    transactionSucceeded: true,
    observedAt: new Date("2026-11-17T12:00:00.000Z"),
    traceId: "trace_01",
    ...overrides,
  };
}

function setup(newlyRecorded = true) {
  const recordLateEvidence = vi.fn().mockResolvedValue({ evidenceId: "onramp_late_evidence_01", newlyRecorded });
  const recorder: OnrampLateEvidenceRecorder = { recordLateEvidence };
  const lines: Array<Record<string, unknown> & { level: number; msg: string }> = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
  return { service: new RecordOnrampLateEvidenceService(recorder, logger), recordLateEvidence, lines };
}

describe("RecordOnrampLateEvidenceService", () => {
  it("writes the entry for a success on a lapsed reservation, with everything the list needs", async () => {
    const { service, recordLateEvidence } = setup();

    await service.handleOtherStageOutcome(outcome());

    expect(recordLateEvidence).toHaveBeenCalledTimes(1);
    expect(recordLateEvidence).toHaveBeenCalledWith({
      providerTransactionId: "txn_late",
      txHash: hash,
      destinationWallet: wallet,
      reservationId: "reservation_01",
      reservationStage: "lapsed",
      amount: "950.000000",
      asset: "EURC",
      state: "eurc_reserved",
      observedAt: new Date("2026-11-17T12:00:00.000Z"),
      traceId: "trace_01",
    } satisfies RecordOnrampLateEvidenceInput);
  });

  it.each(["lapsed", "cancelled", "awaiting_reconfirmation", "reconfirmed", "finalized"])(
    "writes an entry for a success on a %s reservation",
    async (reservationStage) => {
      const { service, recordLateEvidence } = setup();
      await service.handleOtherStageOutcome(outcome({ reservationStage }));
      expect(recordLateEvidence).toHaveBeenCalledWith(expect.objectContaining({ reservationStage }));
    },
  );

  it("keeps a success that does not cover the reservation, in its own state: the money still arrived", async () => {
    const { service, recordLateEvidence } = setup();
    await service.handleOtherStageOutcome(outcome({ state: "purchase_failed", asset: "ETH", amount: "0.200000" }));
    expect(recordLateEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ state: "purchase_failed", asset: "ETH", amount: "0.200000" }),
    );
  });

  it("writes nothing for a failed attempt: no money moved", async () => {
    const { service, recordLateEvidence, lines } = setup();

    await service.handleOtherStageOutcome(outcome({ transactionSucceeded: false, state: "purchase_failed" }));

    expect(recordLateEvidence).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.level >= 40)).toEqual([]);
  });

  it("writes nothing for a reservation that is still initiated, which the recording method would have recorded as money", async () => {
    const { service, recordLateEvidence } = setup();
    await service.handleOtherStageOutcome(outcome({ reservationStage: "initiated" }));
    expect(recordLateEvidence).not.toHaveBeenCalled();
  });

  it("logs a new entry once, at info, with ids and the amount and never the wallet or the hash", async () => {
    const { service, lines } = setup(true);

    await service.handleOtherStageOutcome(outcome());

    const recordedLines = lines.filter((line) => line.event === "offering.onramp_late_evidence_recorded");
    expect(recordedLines).toHaveLength(1);
    expect(recordedLines[0]).toMatchObject({
      level: 30,
      evidence_id: "onramp_late_evidence_01",
      reservation_id: "reservation_01",
      reservation_stage: "lapsed",
      reason: "reservation_lapsed",
      provider_reference: "txn_late",
      state: "eurc_reserved",
      amount: "950.000000",
      asset: "EURC",
    });
    const serialised = JSON.stringify(lines);
    expect(serialised).not.toContain(wallet);
    expect(serialised).not.toContain(hash);
  });

  it("is not an alert: nothing is logged above info for a new entry (no fire-once error line)", async () => {
    const { service, lines } = setup(true);
    await service.handleOtherStageOutcome(outcome());
    expect(lines.filter((line) => line.level >= 40)).toEqual([]);
  });

  it("says nothing the second time the same transaction is seen", async () => {
    const { service, lines } = setup(false);

    await service.handleOtherStageOutcome(outcome());

    expect(lines.filter((line) => line.event === "offering.onramp_late_evidence_recorded")).toEqual([]);
  });

  it("lets a failed write fail the delivery, so the webhook job is retried and the poll counts the reservation as failed", async () => {
    const recorder: OnrampLateEvidenceRecorder = {
      recordLateEvidence: vi.fn().mockRejectedValue(new Error("database unavailable")),
    };
    const service = new RecordOnrampLateEvidenceService(recorder, pino({ level: "silent" }));

    await expect(service.handleOtherStageOutcome(outcome())).rejects.toThrow("database unavailable");
  });
});

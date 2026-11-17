import type { Logger } from "pino";

import { classifyLateOnrampEvidence } from "../domain/onramp-late-evidence.policy.js";
import type { OnrampLateEvidenceRecorder } from "../repository/onramp-late-evidence.repository.js";
import type { OtherStageOnrampOutcome, OtherStageOnrampOutcomeHandler } from "./other-stage-onramp-outcome.js";

/**
 * The late-evidence path of AD-288 (decided 2026-11-17): the handler the poll
 * and the webhook job give an other_stage outcome of the single onramp
 * recording method to. A success for a reservation that has left 'initiated'
 * (lapsed, cancelled, or past funding) is written as an entry of the
 * ops-visibility list, idempotent on the provider transaction id, so the poll,
 * a webhook job and a redelivered webhook that see the same transaction leave
 * one entry (classifyLateOnrampEvidence decides what is worth listing).
 *
 * It holds nothing, reinstates nothing and refunds nothing: the EURC is
 * already in the investor's own wallet (AD-243, AD-251, AD-260 step 9,
 * AD-266). The entry is not a money event and never counts as the
 * reservation's funding.
 *
 * The entry is written after the recording method has returned, in a
 * transaction of its own that takes no reservation lock; the recording method
 * wrote nothing and its lock is released. Idempotence on the provider
 * transaction id is what makes that safe. A write that fails throws, so the
 * webhook job is retried by pg-boss and the minute poll counts the reservation
 * as failed; both re-observe the same transaction. The poll lists 'initiated'
 * reservations only, so for a reservation that lapsed between the poll's list
 * and its lock the webhook retry is the only recovery.
 */
export class RecordOnrampLateEvidenceService implements OtherStageOnrampOutcomeHandler {
  public constructor(
    private readonly evidence: OnrampLateEvidenceRecorder,
    private readonly logger: Logger,
  ) {}

  public async handleOtherStageOutcome(outcome: OtherStageOnrampOutcome): Promise<void> {
    const reason = classifyLateOnrampEvidence({
      reservationStage: outcome.reservationStage,
      transactionSucceeded: outcome.transactionSucceeded,
    });
    if (reason === null) {
      this.logger.debug(
        {
          trace_id: outcome.traceId,
          reservation_id: outcome.reservationId,
          reservation_stage: outcome.reservationStage,
          provider_reference: outcome.providerTransactionId,
          transaction_succeeded: outcome.transactionSucceeded,
        },
        "onramp outcome for a reservation that is no longer initiated moved no money; no late evidence",
      );
      return;
    }

    const result = await this.evidence.recordLateEvidence({
      providerTransactionId: outcome.providerTransactionId,
      txHash: outcome.txHash,
      destinationWallet: outcome.destinationWallet,
      reservationId: outcome.reservationId,
      reservationStage: outcome.reservationStage,
      amount: outcome.amount,
      asset: outcome.asset,
      state: outcome.state,
      observedAt: outcome.observedAt,
      traceId: outcome.traceId,
    });

    // Once per entry, at info: the standing alert (CheckOnrampLateEvidenceService)
    // is what asks for a review; this line is only the trail. Ids, amount and
    // asset: never the destination wallet or the hash.
    if (result.newlyRecorded) {
      this.logger.info(
        {
          event: "offering.onramp_late_evidence_recorded",
          trace_id: outcome.traceId,
          evidence_id: result.evidenceId,
          reservation_id: outcome.reservationId,
          reservation_stage: outcome.reservationStage,
          reason,
          provider_reference: outcome.providerTransactionId,
          state: outcome.state,
          amount: outcome.amount,
          asset: outcome.asset,
        },
        "late onramp funding evidence recorded for staff review; nothing is held or refunded",
      );
    }
  }
}

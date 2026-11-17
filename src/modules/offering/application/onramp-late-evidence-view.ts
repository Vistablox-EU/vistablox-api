import { classifyLateOnrampEvidence } from "../domain/onramp-late-evidence.policy.js";
import type { OnrampLateEvidenceRecord } from "../repository/onramp-late-evidence.repository.js";
import type { OnrampLateEvidenceEntry } from "../api/onramp-late-evidence.schemas.js";

/**
 * One list entry as staff read it. `reason` is how the stored stage reads
 * (classifyLateOnrampEvidence); an entry exists only for a success, so that is
 * what it is classified as.
 */
export function toOnrampLateEvidenceEntry(record: OnrampLateEvidenceRecord): OnrampLateEvidenceEntry {
  return {
    evidence_id: record.evidenceId,
    provider_transaction_id: record.providerTransactionId,
    tx_hash: record.txHash,
    destination_wallet: record.destinationWallet,
    reservation_id: record.reservationId,
    reservation_stage: record.reservationStage,
    current_reservation_stage: record.currentReservationStage,
    reason:
      classifyLateOnrampEvidence({ reservationStage: record.reservationStage, transactionSucceeded: true }) ??
      "reservation_other_stage",
    amount: record.amount,
    asset: record.asset,
    state: record.state,
    observed_at: record.observedAt.toISOString(),
    reviewed_at: record.reviewedAt === null ? null : record.reviewedAt.toISOString(),
  };
}

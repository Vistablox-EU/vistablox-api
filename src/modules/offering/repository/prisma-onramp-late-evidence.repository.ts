import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { MAX_ALERT_EVIDENCE_IDS, type OnrampLateEvidenceSnapshot } from "../domain/onramp-late-evidence-alert.policy.js";
import type { OnrampLateEvidenceState } from "../domain/onramp-late-evidence.policy.js";
import type {
  ListOnrampLateEvidenceInput,
  MarkOnrampLateEvidenceReviewedInput,
  MarkOnrampLateEvidenceReviewedResult,
  OnrampLateEvidenceAlertSource,
  OnrampLateEvidenceRecord,
  OnrampLateEvidenceRecorder,
  OnrampLateEvidenceReviewRepository,
  RecordOnrampLateEvidenceInput,
  RecordOnrampLateEvidenceResult,
} from "./onramp-late-evidence.repository.js";

type EvidenceRow = {
  id: string;
  providerTransactionId: string;
  txHash: string | null;
  destinationWallet: string;
  reservationId: string;
  reservationStage: string;
  amount: { toFixed(decimalPlaces: number): string };
  asset: string;
  state: string;
  observedAt: Date;
  reviewedAt: Date | null;
  reservation: { reservationStage: string };
};

function toRecord(row: EvidenceRow): OnrampLateEvidenceRecord {
  return {
    evidenceId: row.id,
    providerTransactionId: row.providerTransactionId,
    txHash: row.txHash,
    destinationWallet: row.destinationWallet,
    reservationId: row.reservationId,
    reservationStage: row.reservationStage,
    currentReservationStage: row.reservation.reservationStage,
    amount: row.amount.toFixed(6),
    asset: row.asset,
    // The CHECK on the column admits only the two states.
    state: row.state as OnrampLateEvidenceState,
    observedAt: row.observedAt,
    reviewedAt: row.reviewedAt,
  };
}

const withReservationStage = { reservation: { select: { reservationStage: true } } } as const;

export class PrismaOnrampLateEvidenceRepository
  implements OnrampLateEvidenceRecorder, OnrampLateEvidenceReviewRepository, OnrampLateEvidenceAlertSource
{
  public constructor(private readonly database: DatabaseClient) {}

  public async recordLateEvidence(input: RecordOnrampLateEvidenceInput): Promise<RecordOnrampLateEvidenceResult> {
    return this.database.$transaction(async (transaction) => {
      const evidenceId = `onramp_late_evidence_${ulid()}`;
      // ON CONFLICT DO NOTHING on the unique provider transaction id: a second
      // writer for the same transaction waits for the first to commit and then
      // inserts nothing. A missing reservation is not a conflict and throws.
      const written = await transaction.onrampLateEvidence.createMany({
        data: [
          {
            id: evidenceId,
            providerTransactionId: input.providerTransactionId,
            txHash: input.txHash,
            destinationWallet: input.destinationWallet,
            reservationId: input.reservationId,
            reservationStage: input.reservationStage,
            amount: input.amount,
            asset: input.asset,
            state: input.state,
            observedAt: input.observedAt,
          },
        ],
        skipDuplicates: true,
      });
      if (written.count === 0) {
        const existing = await transaction.onrampLateEvidence.findUniqueOrThrow({
          where: { providerTransactionId: input.providerTransactionId },
          select: { id: true },
        });
        return { evidenceId: existing.id, newlyRecorded: false };
      }

      // Ids only: the wallet and the hash stay in the evidence row, never in a
      // log line or an audit row.
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: null,
          action: "offering.onramp_late_evidence_recorded",
          resourceType: "onramp_late_evidence",
          resourceId: evidenceId,
          changes: {
            trace_id: input.traceId,
            reservation_id: input.reservationId,
            provider_transaction_id: input.providerTransactionId,
            reservation_stage: input.reservationStage,
            state: input.state,
          },
          createdAt: input.observedAt,
        },
      });
      return { evidenceId, newlyRecorded: true };
    });
  }

  public async listLateEvidence(input: ListOnrampLateEvidenceInput): Promise<OnrampLateEvidenceRecord[]> {
    const rows = await this.database.onrampLateEvidence.findMany({
      where: {
        ...(input.reviewState === undefined ? {} : { reviewedAt: input.reviewState === "reviewed" ? { not: null } : null }),
        ...(input.after === undefined ? {} : { id: { lt: input.after } }),
      },
      orderBy: { id: "desc" },
      take: input.limit + 1,
      include: withReservationStage,
    });
    return rows.map(toRecord);
  }

  public async markLateEvidenceReviewed(
    input: MarkOnrampLateEvidenceReviewedInput,
  ): Promise<MarkOnrampLateEvidenceReviewedResult> {
    return this.database.$transaction(async (transaction) => {
      // Lock the entry so two staff marking it at once leave one review time
      // and one audit row, and the second sees what the first committed.
      const locked = await transaction.$queryRaw<Array<{ reviewed_at: Date | null }>>`
        SELECT evidence.reviewed_at
        FROM money.onramp_late_evidence AS evidence
        WHERE evidence.onramp_late_evidence_id = ${input.evidenceId}
        FOR UPDATE OF evidence
      `;
      const current = locked[0];
      if (current === undefined) return { status: "not_found" };

      if (current.reviewed_at !== null) {
        const entry = await transaction.onrampLateEvidence.findUniqueOrThrow({
          where: { id: input.evidenceId },
          include: withReservationStage,
        });
        return { status: "already_reviewed", entry: toRecord(entry) };
      }

      const entry = await transaction.onrampLateEvidence.update({
        where: { id: input.evidenceId },
        data: { reviewedAt: input.reviewedAt },
        include: withReservationStage,
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "offering.onramp_late_evidence_reviewed",
          resourceType: "onramp_late_evidence",
          resourceId: entry.id,
          changes: {
            trace_id: input.traceId,
            reservation_id: entry.reservationId,
            provider_transaction_id: entry.providerTransactionId,
            reviewed_at: input.reviewedAt.toISOString(),
          },
          createdAt: input.reviewedAt,
        },
      });
      return { status: "reviewed", entry: toRecord(entry) };
    });
  }

  public async unreviewedLateEvidenceSnapshot(): Promise<OnrampLateEvidenceSnapshot> {
    const [unreviewedCount, oldest] = await Promise.all([
      this.database.onrampLateEvidence.count({ where: { reviewedAt: null } }),
      this.database.onrampLateEvidence.findMany({
        where: { reviewedAt: null },
        orderBy: [{ observedAt: "asc" }, { id: "asc" }],
        take: MAX_ALERT_EVIDENCE_IDS,
        select: { id: true, observedAt: true },
      }),
    ]);
    return {
      unreviewedCount,
      oldestObservedAt: oldest[0]?.observedAt ?? null,
      oldestEvidenceIds: oldest.map((row) => row.id),
    };
  }
}

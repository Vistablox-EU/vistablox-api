import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  LatePaymentRecord,
  LatePaymentReviewRepository,
  LatePaymentWatchReservation,
  ListLatePaymentsInput,
  OnrampPaymentRepository,
  RecordOnrampOutcomeInput,
  RecordOnrampOutcomeResult,
} from "./onramp-payment.repository.js";

export class PrismaOnrampPaymentRepository implements OnrampPaymentRepository, LatePaymentReviewRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async recordOnrampOutcome(input: RecordOnrampOutcomeInput): Promise<RecordOnrampOutcomeResult> {
    return this.database.$transaction(async (transaction) => {
      // Same lock expireReservation takes before flipping 'initiated' to
      // 'lapsed', so the two cannot interleave: either the money event lands
      // while the reservation is still 'initiated' (and expiry then sees it
      // funded), or expiry commits first and this payment is late.
      const locked = await transaction.$queryRaw<Array<{ reservation_stage: string }>>`
        SELECT reservation.reservation_stage
        FROM offering.reservations AS reservation
        WHERE reservation.reservation_id = ${input.reservationId}
        FOR UPDATE OF reservation
      `;
      const current = locked[0];
      if (current === undefined) return { kind: "ignored", reservationStage: null };

      if (current.reservation_stage === "initiated") {
        const capitalState = input.outcome === "funded" ? "eurc_reserved" : "purchase_failed";
        await transaction.moneyEvent.create({
          data: {
            id: `money_event_${ulid()}`,
            reservationId: input.reservationId,
            provider: input.provider,
            providerReference: input.providerReference,
            capitalState,
            amountEur: input.amountEur,
            amountEurc: input.outcome === "funded" ? input.purchaseAmount : null,
            recordedAt: input.recordedAt,
          },
        });
        return { kind: "money_event_recorded", capitalState };
      }

      if (input.outcome === "failed") {
        return { kind: "ignored", reservationStage: current.reservation_stage };
      }

      const latePaymentId = `late_payment_${ulid()}`;
      const inserted = await transaction.$queryRaw<Array<{ late_payment_id: string }>>`
        INSERT INTO money.late_payments (
          late_payment_id,
          reservation_id,
          provider,
          provider_reference,
          reservation_stage_at_detection,
          reserved_amount_eur,
          purchase_currency,
          purchase_amount,
          covers_reservation,
          detected_at
        ) VALUES (
          ${latePaymentId},
          ${input.reservationId},
          ${input.provider},
          ${input.providerReference},
          ${current.reservation_stage},
          ${input.amountEur}::numeric,
          ${input.purchaseCurrency},
          ${input.purchaseAmount}::numeric,
          ${input.outcome === "funded"},
          ${input.recordedAt}
        )
        ON CONFLICT (provider, provider_reference) DO NOTHING
        RETURNING late_payment_id
      `;
      if (inserted[0] === undefined) {
        const existing = await transaction.latePayment.findUniqueOrThrow({
          where: { provider_providerReference: { provider: input.provider, providerReference: input.providerReference } },
          select: { id: true },
        });
        return {
          kind: "late_payment_held",
          latePaymentId: existing.id,
          newlyHeld: false,
          reservationStage: current.reservation_stage,
        };
      }

      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: null,
          action: "offering.late_payment_held",
          resourceType: "reservation",
          resourceId: input.reservationId,
          changes: {
            trace_id: input.traceId,
            late_payment_id: latePaymentId,
            provider: input.provider,
            provider_reference: input.providerReference,
            reservation_stage: current.reservation_stage,
            covers_reservation: input.outcome === "funded",
            review_status: "pending_review",
          },
          createdAt: input.recordedAt,
        },
      });
      return {
        kind: "late_payment_held",
        latePaymentId,
        newlyHeld: true,
        reservationStage: current.reservation_stage,
      };
    });
  }

  public async listLatePaymentWatchReservations(input: { since: Date }): Promise<LatePaymentWatchReservation[]> {
    const rows = await this.database.$queryRaw<
      Array<{ reservation_id: string; account_id: string; amount_eur: string; reservation_stage: string }>
    >`
      SELECT
        reservation.reservation_id,
        reservation.account_id,
        reservation.amount_eur::text,
        reservation.reservation_stage
      FROM offering.reservations AS reservation
      JOIN LATERAL (
        SELECT money_event.capital_state
        FROM money.money_events AS money_event
        WHERE money_event.reservation_id = reservation.reservation_id
        ORDER BY money_event.recorded_at DESC, money_event.money_event_id DESC
        LIMIT 1
      ) AS latest_money ON TRUE
      WHERE reservation.reservation_stage IN ('lapsed', 'cancelled')
        AND reservation.created_at >= ${input.since}
        AND latest_money.capital_state IN ('eurc_purchase_pending', 'purchase_failed')
        AND NOT EXISTS (
          SELECT 1
          FROM money.late_payments AS late_payment
          WHERE late_payment.reservation_id = reservation.reservation_id
        )
    `;
    return rows.map((row) => ({
      reservationId: row.reservation_id,
      accountId: row.account_id,
      amountEur: row.amount_eur,
      reservationStage: row.reservation_stage,
    }));
  }

  public async listLatePayments(input: ListLatePaymentsInput): Promise<LatePaymentRecord[]> {
    const rows = await this.database.latePayment.findMany({
      where: {
        ...(input.reviewStatus === undefined ? {} : { reviewStatus: input.reviewStatus }),
        ...(input.after === undefined ? {} : { id: { lt: input.after } }),
      },
      orderBy: { id: "desc" },
      take: input.limit + 1,
      include: {
        reservation: { select: { offeringId: true, accountId: true, reservationStage: true } },
      },
    });
    return rows.map((row) => ({
      latePaymentId: row.id,
      reservationId: row.reservationId,
      offeringId: row.reservation.offeringId,
      accountId: row.reservation.accountId,
      provider: row.provider,
      providerReference: row.providerReference,
      reservationStageAtDetection: row.reservationStageAtDetection,
      currentReservationStage: row.reservation.reservationStage,
      reservedAmountEur: row.reservedAmountEur.toFixed(2),
      purchaseCurrency: row.purchaseCurrency,
      purchaseAmount: row.purchaseAmount.toFixed(6),
      coversReservation: row.coversReservation,
      reviewStatus: row.reviewStatus,
      detectedAt: row.detectedAt,
    }));
  }
}

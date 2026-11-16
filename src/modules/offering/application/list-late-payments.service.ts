import type { LatePaymentReviewStatus } from "../domain/late-payment.policy.js";
import type { LatePaymentReviewRepository } from "../repository/onramp-payment.repository.js";

export interface ListLatePaymentsQuery {
  limit: number;
  after?: string | undefined;
  review_status?: LatePaymentReviewStatus | undefined;
}

/** Staff read of the late-payment manual-review queue (issue #168). */
export class ListLatePaymentsService {
  public constructor(private readonly latePayments: LatePaymentReviewRepository) {}

  public async execute(query: ListLatePaymentsQuery) {
    const rows = await this.latePayments.listLatePayments({
      limit: query.limit,
      ...(query.after === undefined ? {} : { after: query.after }),
      ...(query.review_status === undefined ? {} : { reviewStatus: query.review_status }),
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map((row) => ({
        late_payment_id: row.latePaymentId,
        reservation_id: row.reservationId,
        offering_id: row.offeringId,
        account_id: row.accountId,
        provider: row.provider,
        provider_reference: row.providerReference,
        reservation_stage_at_detection: row.reservationStageAtDetection,
        current_reservation_stage: row.currentReservationStage,
        reserved_amount_eur: row.reservedAmountEur,
        purchase_currency: row.purchaseCurrency,
        purchase_amount: row.purchaseAmount,
        covers_reservation: row.coversReservation,
        review_status: row.reviewStatus,
        detected_at: row.detectedAt.toISOString(),
      })),
      page: { next_cursor: rows.length > query.limit ? (page.at(-1)?.latePaymentId ?? null) : null },
    };
  }
}

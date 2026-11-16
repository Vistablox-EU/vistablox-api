import { z } from "zod";

import { LATE_PAYMENT_REVIEW_STATUSES } from "../domain/late-payment.policy.js";

export const latePaymentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().min(1).optional(),
  review_status: z.enum(LATE_PAYMENT_REVIEW_STATUSES).optional(),
});

export const latePaymentListResponseSchema = z.object({
  data: z.array(
    z.object({
      late_payment_id: z.string().min(1),
      reservation_id: z.string().min(1),
      offering_id: z.string().min(1),
      account_id: z.string().min(1),
      provider: z.string().min(1),
      provider_reference: z.string().min(1),
      reservation_stage_at_detection: z.string().min(1),
      current_reservation_stage: z.string().min(1),
      reserved_amount_eur: z.string().regex(/^\d+\.\d{2}$/),
      purchase_currency: z.string().min(1),
      purchase_amount: z.string().regex(/^\d+\.\d{6}$/),
      covers_reservation: z.boolean(),
      review_status: z.enum(LATE_PAYMENT_REVIEW_STATUSES),
      detected_at: z.iso.datetime(),
    }),
  ),
  page: z.object({ next_cursor: z.string().nullable() }),
});

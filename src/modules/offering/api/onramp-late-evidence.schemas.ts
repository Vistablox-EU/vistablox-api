import { z } from "zod";

import { ONRAMP_LATE_EVIDENCE_STATES } from "../domain/onramp-late-evidence.policy.js";

export const onrampLateEvidenceListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().min(1).max(200).optional(),
  review_state: z.enum(["unreviewed", "reviewed"]).optional(),
});

export const onrampLateEvidenceParamsSchema = z.object({
  evidence_id: z.string().min(1).max(200),
});

const onrampLateEvidenceEntrySchema = z.object({
  evidence_id: z.string().min(1),
  provider_transaction_id: z.string().min(1),
  tx_hash: z.string().min(1).nullable(),
  destination_wallet: z.string().min(1),
  reservation_id: z.string().min(1),
  /** The reservation's stage when the transaction was seen. */
  reservation_stage: z.string().min(1),
  /** The reservation's stage now. */
  current_reservation_stage: z.string().min(1),
  reason: z.enum([
    "reservation_lapsed",
    "reservation_cancelled",
    "reservation_funded_already",
    "reservation_other_stage",
  ]),
  amount: z.string().regex(/^\d+\.\d{6}$/),
  asset: z.string().min(1),
  state: z.enum(ONRAMP_LATE_EVIDENCE_STATES),
  observed_at: z.iso.datetime(),
  reviewed_at: z.iso.datetime().nullable(),
});

export type OnrampLateEvidenceEntry = z.infer<typeof onrampLateEvidenceEntrySchema>;

export const onrampLateEvidenceListResponseSchema = z.object({
  data: z.array(onrampLateEvidenceEntrySchema),
  page: z.object({ next_cursor: z.string().nullable() }),
});

export const markOnrampLateEvidenceReviewedResponseSchema = z.object({
  data: onrampLateEvidenceEntrySchema,
});

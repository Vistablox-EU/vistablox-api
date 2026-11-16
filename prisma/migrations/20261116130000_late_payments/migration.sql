-- Issue #168: a provider payment that completes after its reservation has
-- already lapsed or been cancelled is held here for manual staff review.
-- It is never written to money.money_events, so it can never count as the
-- reservation's funding, and nothing here reinstates or refunds anything.
CREATE TABLE "money"."late_payments" (
    "late_payment_id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_reference" TEXT NOT NULL,
    "reservation_stage_at_detection" TEXT NOT NULL,
    "reserved_amount_eur" DECIMAL(15,2) NOT NULL,
    "purchase_currency" TEXT NOT NULL,
    "purchase_amount" DECIMAL(20,6) NOT NULL,
    "covers_reservation" BOOLEAN NOT NULL,
    "review_status" TEXT NOT NULL DEFAULT 'pending_review',
    "detected_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "late_payments_pkey" PRIMARY KEY ("late_payment_id"),
    CONSTRAINT "late_payments_review_status_check"
        CHECK ("review_status" IN ('pending_review')),
    CONSTRAINT "late_payments_reservation_stage_check"
        CHECK ("reservation_stage_at_detection" <> 'initiated'),
    CONSTRAINT "late_payments_purchase_amount_check"
        CHECK ("purchase_amount" >= 0)
);

-- One row per provider transaction: the poller re-reads the same completed
-- transaction every run, and this makes the hold idempotent.
CREATE UNIQUE INDEX "uq_late_payments_provider_reference" ON "money"."late_payments"("provider", "provider_reference");

CREATE INDEX "idx_late_payments_review_status_detected" ON "money"."late_payments"("review_status", "detected_at");

CREATE INDEX "idx_late_payments_reservation" ON "money"."late_payments"("reservation_id");

ALTER TABLE "money"."late_payments" ADD CONSTRAINT "late_payments_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "offering"."reservations"("reservation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- money.onramp_late_evidence: the ops-visibility list of late onramp funding
-- evidence (AD-288, decided 2026-11-17; issue #168). When the single onramp
-- recording method answers other_stage -- Coinbase reports a success for a
-- reservation that has already left 'initiated' (lapsed, cancelled, or past
-- funding) -- it writes no money event, and the late path writes one row here
-- so staff can see that it happened.
--
-- What a row is NOT: a hold, a claim on the funds, or a step towards a refund
-- or a reinstatement. The EURC went straight to the investor's own wallet
-- (AD-243), there is no refund (AD-251), and an expired intent is not revived
-- (AD-260 step 9, AD-266). The table therefore has no status column besides
-- reviewed_at, and nothing reads it to decide anything about a reservation.
-- It never counts as the reservation's funding: it is a different table from
-- money.money_events, and no query that sums funded capital reads it.
--
-- What it enforces:
--   * provider_transaction_id is unique, so the poll and the webhook job, or a
--     redelivered webhook, that see the same Coinbase transaction again insert
--     nothing (INSERT ... ON CONFLICT DO NOTHING);
--   * reservation_stage is never 'initiated': an initiated reservation takes
--     the money event, it is not late;
--   * state is one of the two the recording method would have written
--     (eurc_reserved: the success covers the reservation; purchase_failed: it
--     does not), and amount is a non-negative number. Like the other money
--     checks (20261018131001) the amount check also excludes NaN, which
--     PostgreSQL orders above every number;
--   * length limits on the text columns, so a verified but oversized provider
--     value cannot grow a row without bound;
--   * a row is immutable except that reviewed_at can be set, once, from NULL
--     (BEFORE UPDATE OR DELETE trigger, the pattern of money.money_events and
--     money.onramp_webhook_receipts). Like those triggers it is not a
--     privilege boundary, and TRUNCATE is not guarded. Retention is an open
--     question; when it is decided it needs its own migration.
--
-- destination_wallet and tx_hash are what Coinbase reported for the
-- transaction (COINBASE_ONRAMP.md: keep the hash and the destination for
-- on-chain reconciliation). The wallet is a public address linkable to an
-- investor, so it is shown to staff in the list and never written to a log
-- line, an alert or an audit row.
--
-- Purely additive: a new, empty table with one foreign key to
-- offering.reservations, so no existing row can violate any constraint and
-- nothing existing is read, rewritten or constrained.

-- CreateTable
CREATE TABLE "money"."onramp_late_evidence" (
    "onramp_late_evidence_id" TEXT NOT NULL,
    "provider_transaction_id" TEXT NOT NULL,
    "tx_hash" TEXT,
    "destination_wallet" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "reservation_stage" TEXT NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "asset" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "reviewed_at" TIMESTAMPTZ(6),

    CONSTRAINT "onramp_late_evidence_pkey" PRIMARY KEY ("onramp_late_evidence_id"),
    CONSTRAINT "onramp_late_evidence_provider_transaction_id_length_check" CHECK (char_length("provider_transaction_id") BETWEEN 1 AND 200),
    CONSTRAINT "onramp_late_evidence_tx_hash_length_check" CHECK ("tx_hash" IS NULL OR char_length("tx_hash") BETWEEN 1 AND 200),
    CONSTRAINT "onramp_late_evidence_destination_wallet_length_check" CHECK (char_length("destination_wallet") BETWEEN 1 AND 200),
    CONSTRAINT "onramp_late_evidence_asset_length_check" CHECK (char_length("asset") BETWEEN 1 AND 32),
    CONSTRAINT "onramp_late_evidence_reservation_stage_check" CHECK ("reservation_stage" <> 'initiated'),
    CONSTRAINT "onramp_late_evidence_amount_check" CHECK ("amount" >= 0 AND "amount" <> 'NaN'),
    CONSTRAINT "onramp_late_evidence_state_check" CHECK ("state" IN ('eurc_reserved', 'purchase_failed'))
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_onramp_late_evidence_provider_transaction_id" ON "money"."onramp_late_evidence"("provider_transaction_id");

-- CreateIndex
CREATE INDEX "idx_onramp_late_evidence_review_observed" ON "money"."onramp_late_evidence"("reviewed_at", "observed_at");

-- CreateIndex
CREATE INDEX "idx_onramp_late_evidence_reservation" ON "money"."onramp_late_evidence"("reservation_id");

-- AddForeignKey
ALTER TABLE "money"."onramp_late_evidence" ADD CONSTRAINT "onramp_late_evidence_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "offering"."reservations"("reservation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An entry is evidence: immutable, except that staff mark it reviewed, once.
CREATE OR REPLACE FUNCTION "money"."guard_onramp_late_evidence_change"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."reviewed_at" IS NULL
     AND NEW."reviewed_at" IS NOT NULL
     AND (
       NEW."onramp_late_evidence_id", NEW."provider_transaction_id", NEW."tx_hash", NEW."destination_wallet",
       NEW."reservation_id", NEW."reservation_stage", NEW."amount", NEW."asset", NEW."state", NEW."observed_at"
     ) IS NOT DISTINCT FROM (
       OLD."onramp_late_evidence_id", OLD."provider_transaction_id", OLD."tx_hash", OLD."destination_wallet",
       OLD."reservation_id", OLD."reservation_stage", OLD."amount", OLD."asset", OLD."state", OLD."observed_at"
     )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'onramp late evidence is immutable; an entry can only be marked reviewed, once'
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'Set reviewed_at on an entry that has none; nothing else may change or be deleted.';
END;
$$;

DROP TRIGGER IF EXISTS "onramp_late_evidence_guard" ON "money"."onramp_late_evidence";

CREATE TRIGGER "onramp_late_evidence_guard"
BEFORE UPDATE OR DELETE ON "money"."onramp_late_evidence"
FOR EACH ROW EXECUTE FUNCTION "money"."guard_onramp_late_evidence_change"();

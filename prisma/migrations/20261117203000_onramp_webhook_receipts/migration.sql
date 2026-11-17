-- money.onramp_webhook_receipts: the durable, minimised record of each verified
-- Coinbase CDP onramp webhook delivery (AD-289, decided 2026-11-17). The record
-- (COINBASE_ONRAMP.md, "Webhooks") says the handler persists the event as
-- evidence and enqueues the downstream work (AD-062). A pg-boss job row cannot
-- be that evidence: it is archived and deleted by retention, and a completed
-- job leaves no key a redelivery can be matched against. This table is the
-- evidence and the duplicate guard.
--
-- What it holds, and what it never holds:
--   * ids only: the delivery's event id, the event type, Coinbase's
--     transaction id, the on-chain tx hash, and partner_user_ref (the
--     reservation id the onramp session was opened with);
--   * never the request body, the signature header or any secret.
--
-- What it enforces:
--   * event_id is unique, so a redelivery of an event already on file inserts
--     nothing (INSERT ... ON CONFLICT DO NOTHING in the same transaction that
--     enqueues the job; see PrismaOfferingRepository.receiveOnrampWebhook);
--   * length limits matching the route's own validation, so a verified but
--     oversized field cannot grow a row without bound;
--   * every UPDATE or DELETE is rejected (SQLSTATE 23000), the same
--     BEFORE UPDATE OR DELETE trigger money.money_events uses
--     (20261018131000_money_events_append_only). Like that trigger it is not a
--     privilege boundary, and TRUNCATE is not guarded. Retention is an open
--     question; when it is decided it needs its own migration.
--
-- partner_user_ref has no foreign key to offering.reservations on purpose: an
-- event whose reservation this database does not know is still evidence, and a
-- foreign key would turn it into a failed write that Coinbase retries.
--
-- Purely additive: a new, empty table, so no existing row can violate any of
-- its constraints, and nothing existing is read, rewritten or constrained.

-- CreateTable
CREATE TABLE "money"."onramp_webhook_receipts" (
    "onramp_webhook_receipt_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "transaction_id" TEXT,
    "tx_hash" TEXT,
    "partner_user_ref" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onramp_webhook_receipts_pkey" PRIMARY KEY ("onramp_webhook_receipt_id"),
    CONSTRAINT "onramp_webhook_receipts_event_id_length_check" CHECK (char_length("event_id") BETWEEN 1 AND 200),
    CONSTRAINT "onramp_webhook_receipts_event_type_length_check" CHECK (char_length("event_type") BETWEEN 1 AND 100),
    CONSTRAINT "onramp_webhook_receipts_transaction_id_length_check" CHECK ("transaction_id" IS NULL OR char_length("transaction_id") BETWEEN 1 AND 200),
    CONSTRAINT "onramp_webhook_receipts_tx_hash_length_check" CHECK ("tx_hash" IS NULL OR char_length("tx_hash") BETWEEN 1 AND 200),
    CONSTRAINT "onramp_webhook_receipts_partner_user_ref_length_check" CHECK (char_length("partner_user_ref") BETWEEN 1 AND 200)
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_onramp_webhook_receipts_event_id" ON "money"."onramp_webhook_receipts"("event_id");

-- CreateIndex
CREATE INDEX "idx_onramp_webhook_receipts_partner_user_ref" ON "money"."onramp_webhook_receipts"("partner_user_ref", "received_at" DESC);

-- Append-only, as money.money_events is.
CREATE OR REPLACE FUNCTION "money"."reject_onramp_webhook_receipt_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'onramp webhook receipts are append-only'
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'Insert a new receipt instead of changing an existing one.';
END;
$$;

DROP TRIGGER IF EXISTS "onramp_webhook_receipts_append_only" ON "money"."onramp_webhook_receipts";

CREATE TRIGGER "onramp_webhook_receipts_append_only"
BEFORE UPDATE OR DELETE ON "money"."onramp_webhook_receipts"
FOR EACH ROW EXECUTE FUNCTION "money"."reject_onramp_webhook_receipt_mutation"();

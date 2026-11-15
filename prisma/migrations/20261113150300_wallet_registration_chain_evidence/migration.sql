-- Chain evidence for wallet registrations (issue #149).
--
-- The watcher used to confirm a registration with only registered_at, so the
-- row kept no record of which event confirmed it. This adds the event's
-- identity, written in the same UPDATE as registered_at, and the state the
-- job needs to re-check that event later:
--   * registration_block_hash   hash of the block that held the event when it
--                               was recorded. Compared with the chain later to
--                               notice a reorganization.
--   * registration_log_index    the log's position in its block (viem returns
--                               the block-wide index for logs and receipts
--                               alike).
--   * registration_evidence_verified_at
--                               set once the block is deep enough to count as
--                               final; the row leaves the re-check set.
--   * registration_evidence_flagged_at / registration_evidence_flag
--                               set when the event is no longer on the chain
--                               (transaction_missing, transaction_reverted or
--                               event_missing). registered_at is never
--                               reverted: a flag is information for staff, not
--                               a state change.
-- registration_tx_hash and registration_block_number already exist
-- (20260916110000_wallet_registration_reconciliation) and stay.
--
-- The identity of an event is (registration_tx_hash, registration_log_index),
-- not the transaction hash alone. VistaBloxWalletRegistry keeps no state and
-- takes any caller, and a bundler (AD-271) can relay several registrations in
-- one transaction, so one hash can legitimately back several rows. The unique
-- index on registration_tx_hash alone would make the second one fail, so it is
-- dropped and replaced by a unique index on the pair. A row written before this
-- migration has a transaction hash and block number but no log index; it is
-- left out of the pair index (NULL) and is completed the next time the watcher
-- or a reconcile sees its event.
--
-- Manual reconcile used to store the transaction hash in whatever case staff
-- typed it. Every hash is now stored lower case, so the existing ones are
-- lower-cased here (lossless; the old unique index is dropped first so the
-- rewrite cannot collide inside it).
--
-- Three CHECK constraints keep the columns consistent with each other:
--   * ..._evidence_shape_check: transaction hash and block number come
--     together, block hash and log index come together, a block hash needs a
--     transaction hash, and a transaction hash needs registered_at (evidence on
--     a pending row would be a confirmation that did not happen).
--   * ..._evidence_format_check: lower-case 0x + 64 hex digits for both hashes,
--     non-negative block number and log index.
--   * ..._evidence_state_check: the flag and its timestamp come together, the
--     flag is one of the three reasons, and verified/flagged timestamps need a
--     block hash to refer to.
--
-- Each constraint is added NOT VALID, like 20261018131001, so this migration
-- cannot fail on data that already exists, and is then validated in the DO
-- block at the end. If an existing row violates one, that constraint stays NOT
-- VALID (a NOTICE says which) and an UPDATE of that one row fails until it is
-- corrected. Rows can only violate them through a hand edit: the API's regex and
-- the reconcile code cannot produce a malformed hash or half a pair.
--
-- To find rows that violate a constraint (each query should return no rows):
--   SELECT account_id FROM settlement.wallet_registrations WHERE NOT (
--     (registration_tx_hash IS NULL) = (registration_block_number IS NULL)
--     AND (registration_block_hash IS NULL) = (registration_log_index IS NULL)
--     AND (registration_block_hash IS NULL OR registration_tx_hash IS NOT NULL)
--     AND (registration_tx_hash IS NULL OR registered_at IS NOT NULL));
--   SELECT account_id, registration_tx_hash, registration_block_hash FROM settlement.wallet_registrations WHERE NOT (
--     (registration_tx_hash IS NULL OR registration_tx_hash ~ '^0x[0-9a-f]{64}$')
--     AND (registration_block_hash IS NULL OR registration_block_hash ~ '^0x[0-9a-f]{64}$')
--     AND (registration_block_number IS NULL OR registration_block_number >= 0)
--     AND (registration_log_index IS NULL OR registration_log_index >= 0));
--   SELECT account_id FROM settlement.wallet_registrations WHERE NOT (
--     (registration_evidence_flagged_at IS NULL) = (registration_evidence_flag IS NULL)
--     AND (registration_evidence_flag IS NULL OR registration_evidence_flag IN ('transaction_missing', 'transaction_reverted', 'event_missing'))
--     AND (registration_evidence_verified_at IS NULL OR registration_block_hash IS NOT NULL)
--     AND (registration_evidence_flagged_at IS NULL OR registration_block_hash IS NOT NULL));
-- Informational (legacy rows that share a transaction hash; impossible before
-- this migration except for case variants, and allowed afterwards when the
-- rows carry different log indexes):
--   SELECT registration_tx_hash, count(*) FROM settlement.wallet_registrations
--     WHERE registration_tx_hash IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
-- Once a constraint's query is clean, validate it, for example:
--   ALTER TABLE settlement.wallet_registrations
--     VALIDATE CONSTRAINT wallet_registrations_registration_evidence_shape_check;
--
-- Safe to re-run: every statement is IF [NOT] EXISTS, the UPDATE matches nothing
-- the second time, and each constraint is dropped and re-added NOT VALID before
-- the DO block validates it again. Nothing here needs PostgreSQL 18.

-- 1. The transaction-hash-only unique index goes first.
DROP INDEX IF EXISTS "settlement"."wallet_registrations_registration_tx_hash_key";

-- 2. Columns. Nullable, no default: a metadata-only change.
ALTER TABLE "settlement"."wallet_registrations"
  ADD COLUMN IF NOT EXISTS "registration_block_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "registration_log_index" INTEGER,
  ADD COLUMN IF NOT EXISTS "registration_evidence_verified_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "registration_evidence_flagged_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "registration_evidence_flag" TEXT;

-- 3. One stored spelling for transaction hashes.
UPDATE "settlement"."wallet_registrations"
   SET "registration_tx_hash" = lower("registration_tx_hash")
 WHERE "registration_tx_hash" IS NOT NULL
   AND "registration_tx_hash" <> lower("registration_tx_hash");

-- 4. Constraints, NOT VALID.
ALTER TABLE "settlement"."wallet_registrations" DROP CONSTRAINT IF EXISTS "wallet_registrations_registration_evidence_shape_check";
ALTER TABLE "settlement"."wallet_registrations"
  ADD CONSTRAINT "wallet_registrations_registration_evidence_shape_check" CHECK (
    (("registration_tx_hash" IS NULL) = ("registration_block_number" IS NULL))
    AND (("registration_block_hash" IS NULL) = ("registration_log_index" IS NULL))
    AND ("registration_block_hash" IS NULL OR "registration_tx_hash" IS NOT NULL)
    AND ("registration_tx_hash" IS NULL OR "registered_at" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "settlement"."wallet_registrations" DROP CONSTRAINT IF EXISTS "wallet_registrations_registration_evidence_format_check";
ALTER TABLE "settlement"."wallet_registrations"
  ADD CONSTRAINT "wallet_registrations_registration_evidence_format_check" CHECK (
    ("registration_tx_hash" IS NULL OR "registration_tx_hash" ~ '^0x[0-9a-f]{64}$')
    AND ("registration_block_hash" IS NULL OR "registration_block_hash" ~ '^0x[0-9a-f]{64}$')
    AND ("registration_block_number" IS NULL OR "registration_block_number" >= 0)
    AND ("registration_log_index" IS NULL OR "registration_log_index" >= 0)
  ) NOT VALID;

ALTER TABLE "settlement"."wallet_registrations" DROP CONSTRAINT IF EXISTS "wallet_registrations_registration_evidence_state_check";
ALTER TABLE "settlement"."wallet_registrations"
  ADD CONSTRAINT "wallet_registrations_registration_evidence_state_check" CHECK (
    (("registration_evidence_flagged_at" IS NULL) = ("registration_evidence_flag" IS NULL))
    AND ("registration_evidence_flag" IS NULL OR "registration_evidence_flag" IN ('transaction_missing', 'transaction_reverted', 'event_missing'))
    AND ("registration_evidence_verified_at" IS NULL OR "registration_block_hash" IS NOT NULL)
    AND ("registration_evidence_flagged_at" IS NULL OR "registration_block_hash" IS NOT NULL)
  ) NOT VALID;

-- 5. Indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_wallet_registrations_chain_event"
  ON "settlement"."wallet_registrations" ("registration_tx_hash", "registration_log_index")
  WHERE "registration_tx_hash" IS NOT NULL AND "registration_log_index" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_wallet_registrations_tx_hash"
  ON "settlement"."wallet_registrations" ("registration_tx_hash")
  WHERE "registration_tx_hash" IS NOT NULL;

-- The job's re-check set: rows with a recorded block hash that are neither
-- verified nor flagged, oldest block first.
CREATE INDEX IF NOT EXISTS "idx_wallet_registrations_evidence_recheck"
  ON "settlement"."wallet_registrations" ("registration_block_number")
  WHERE "registration_block_hash" IS NOT NULL
    AND "registration_evidence_verified_at" IS NULL
    AND "registration_evidence_flagged_at" IS NULL;

-- 6. Validate what can be validated. A constraint that existing rows violate
--    stays NOT VALID and is reported, so a deploy never fails on old data.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOREACH constraint_name IN ARRAY ARRAY[
    'wallet_registrations_registration_evidence_shape_check',
    'wallet_registrations_registration_evidence_format_check',
    'wallet_registrations_registration_evidence_state_check'
  ] LOOP
    BEGIN
      EXECUTE format('ALTER TABLE "settlement"."wallet_registrations" VALIDATE CONSTRAINT %I', constraint_name);
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'wallet_registrations: % left NOT VALID: existing rows violate it (find them with the query in this migration''s header)', constraint_name;
    END;
  END LOOP;
END
$$;

-- money.money_events is the evidence log for every investor funding and escrow
-- step: CORE_TABLES.md calls it "Append-only by design" and LEDGER_DESIGN.md
-- says "never UPDATE or DELETE a money_events row ... A correction is a new
-- row, not an edit". Until now that was convention only; nothing in the
-- database stopped a hand-run UPDATE or DELETE from rewriting financial
-- history. This applies the same BEFORE UPDATE OR DELETE trigger that
-- intake_case_events (20260918120000_intake_case_event_ledger) and
-- submission_revisions (20260831163000_immutable_submission_revisions) use.
--
-- What it covers:
--   * Every UPDATE or DELETE of a money_events row is rejected with SQLSTATE
--     23000, including an UPDATE that assigns a column its current value.
--   * That includes reconciled_at. RECONCILIATION.md says matching rows are
--     marked reconciled_at in place, which contradicts the "never UPDATE" rule
--     in LEDGER_DESIGN.md. No application code writes reconciled_at today, so
--     this enforces the rule as written. When the reconciliation job is built
--     the record has to choose between a narrow carve-out (reconciled_at
--     NULL -> non-NULL with every other column unchanged) and recording
--     reconciliation somewhere else; either choice is a new migration.
--   * money_events_reservation_id_fkey is ON UPDATE CASCADE, so renaming an
--     offering.reservations.reservation_id that has money events would cascade
--     an UPDATE into this table. That is rejected too. Deleting such a
--     reservation was already blocked by the foreign key's ON DELETE RESTRICT.
--
-- What it does not cover:
--   * TRUNCATE is not guarded, the same as the two tables above.
--   * The trigger is not a privilege boundary: the table owner or a superuser
--     can DISABLE it, and session_replication_role = replica skips it. Taking
--     UPDATE, DELETE and TRUNCATE away from the application's database role is
--     a separate step this migration does not take.
--   * Rows already in the table are untouched; the trigger is not retroactive.
--
-- Safe to re-run: the function is replaced and the trigger is dropped and
-- re-created.
CREATE OR REPLACE FUNCTION "money"."reject_money_event_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'money events are append-only'
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'Record a new money_events row instead of changing an existing one.';
END;
$$;

DROP TRIGGER IF EXISTS "money_events_append_only" ON "money"."money_events";

CREATE TRIGGER "money_events_append_only"
BEFORE UPDATE OR DELETE ON "money"."money_events"
FOR EACH ROW EXECUTE FUNCTION "money"."reject_money_event_mutation"();

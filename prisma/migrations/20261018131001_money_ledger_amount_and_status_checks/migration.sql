-- Database-level invariants for the money ledger and the tables it hangs off.
-- Before this the money, offering and settlement tables had no CHECK at all
-- (apart from the dormant dual_approval_distinct_operators), so a bug or a
-- hand-run statement could store a zero or negative amount or an
-- unrecognised status without any database error.
--
-- Only invariants the design record and the application code agree on are
-- added here:
--   * money_events.amount_eur > 0 and money_events.amount_eurc > 0 when set.
--     Every row the application writes carries the reservation's amount (never
--     a signed delta), and the EURC amount is only recorded for a purchase
--     that credited more than zero. A correction is a new row in a state, not
--     a negative amount (LEDGER_DESIGN.md).
--   * reservations.amount_eur > 0 (the API already rejects anything else,
--     and AD-225 sets a minimum ticket).
--   * offerings.minimum_raise_eur > 0 and offerings.target_raise_eur > 0.
--     No ordering between the two is enforced: CORE_TABLES.md makes the target
--     equal to the minimum for now and leaves open whether a later decision
--     separates them.
--   * offerings.status in (pre_offering, final_offering, closed), the set in
--     CORE_TABLES.md and the only values the application writes.
--   * position_ledger.position_status in (pending_internal_settlement, active,
--     redeemed), the set CORE_TABLES.md, LEDGER_DESIGN.md and PAYMENT_FLOWS.md
--     all list; the application writes the first two and has not built
--     redemption yet.
--   * position_ledger.unit_count >= 0 and cost_basis_eur >= 0. Non-negative
--     rather than positive on purpose: an owner-retained position has no cash
--     cost basis and the record has not decided its contributed-property basis
--     or whether a fully reduced retained balance keeps its row. The positions
--     the application creates for investors carry the invested amount as both
--     figures (1 unit per EUR, AD-247).
--
-- Deliberately not constrained, because the record and the code disagree or
-- the record is itself unsettled: money_events.capital_state (the code writes
-- eurc_reserved, which AD-260 supersedes by eurc_escrowed),
-- reservations.reservation_stage (CORE_TABLES.md lists eight values,
-- DATA_MODEL.md six), money_events.provider, and payouts / treasury sweep
-- batches (no application code writes them).
--
-- Every constraint is added NOT VALID so this migration cannot fail on, or
-- lock for a table scan over, data that already exists. A NOT VALID constraint
-- is enforced for every INSERT and UPDATE from now on, and an existing row
-- that violates it is not examined until the constraint is validated. For the
-- three tables that are updated in place (reservations, offerings,
-- position_ledger) the new row version is checked, so an UPDATE of an existing
-- violating row fails until that row is corrected.
--
-- To find rows that violate a constraint (each query should return no rows):
--   SELECT money_event_id, amount_eur FROM money.money_events WHERE NOT (amount_eur > 0);
--   SELECT money_event_id, amount_eurc FROM money.money_events WHERE NOT (amount_eurc IS NULL OR amount_eurc > 0);
--   SELECT reservation_id, amount_eur FROM offering.reservations WHERE NOT (amount_eur > 0);
--   SELECT offering_id, status FROM offering.offerings WHERE status NOT IN ('pre_offering', 'final_offering', 'closed');
--   SELECT offering_id, minimum_raise_eur FROM offering.offerings WHERE NOT (minimum_raise_eur > 0);
--   SELECT offering_id, target_raise_eur FROM offering.offerings WHERE NOT (target_raise_eur > 0);
--   SELECT position_id, position_status FROM settlement.position_ledger WHERE position_status NOT IN ('pending_internal_settlement', 'active', 'redeemed');
--   SELECT position_id, unit_count FROM settlement.position_ledger WHERE NOT (unit_count >= 0);
--   SELECT position_id, cost_basis_eur FROM settlement.position_ledger WHERE NOT (cost_basis_eur >= 0);
-- Once a constraint's query is clean, validate it, for example:
--   ALTER TABLE money.money_events VALIDATE CONSTRAINT money_events_amount_eur_positive_check;
-- A violating money_events row cannot be repaired with UPDATE once
-- 20261018131000_money_events_append_only is applied; it needs a decision
-- before that constraint can be validated.
--
-- Safe to re-run: each constraint is dropped if present and re-added NOT
-- VALID, so one that was already validated goes back to NOT VALID until it is
-- validated again.

ALTER TABLE "money"."money_events" DROP CONSTRAINT IF EXISTS "money_events_amount_eur_positive_check";
ALTER TABLE "money"."money_events"
  ADD CONSTRAINT "money_events_amount_eur_positive_check" CHECK ("amount_eur" > 0) NOT VALID;

ALTER TABLE "money"."money_events" DROP CONSTRAINT IF EXISTS "money_events_amount_eurc_positive_check";
ALTER TABLE "money"."money_events"
  ADD CONSTRAINT "money_events_amount_eurc_positive_check" CHECK ("amount_eurc" IS NULL OR "amount_eurc" > 0) NOT VALID;

ALTER TABLE "offering"."reservations" DROP CONSTRAINT IF EXISTS "reservations_amount_eur_positive_check";
ALTER TABLE "offering"."reservations"
  ADD CONSTRAINT "reservations_amount_eur_positive_check" CHECK ("amount_eur" > 0) NOT VALID;

ALTER TABLE "offering"."offerings" DROP CONSTRAINT IF EXISTS "offerings_status_check";
ALTER TABLE "offering"."offerings"
  ADD CONSTRAINT "offerings_status_check" CHECK ("status" IN ('pre_offering', 'final_offering', 'closed')) NOT VALID;

ALTER TABLE "offering"."offerings" DROP CONSTRAINT IF EXISTS "offerings_minimum_raise_eur_positive_check";
ALTER TABLE "offering"."offerings"
  ADD CONSTRAINT "offerings_minimum_raise_eur_positive_check" CHECK ("minimum_raise_eur" > 0) NOT VALID;

ALTER TABLE "offering"."offerings" DROP CONSTRAINT IF EXISTS "offerings_target_raise_eur_positive_check";
ALTER TABLE "offering"."offerings"
  ADD CONSTRAINT "offerings_target_raise_eur_positive_check" CHECK ("target_raise_eur" > 0) NOT VALID;

ALTER TABLE "settlement"."position_ledger" DROP CONSTRAINT IF EXISTS "position_ledger_position_status_check";
ALTER TABLE "settlement"."position_ledger"
  ADD CONSTRAINT "position_ledger_position_status_check"
  CHECK ("position_status" IN ('pending_internal_settlement', 'active', 'redeemed')) NOT VALID;

ALTER TABLE "settlement"."position_ledger" DROP CONSTRAINT IF EXISTS "position_ledger_unit_count_non_negative_check";
ALTER TABLE "settlement"."position_ledger"
  ADD CONSTRAINT "position_ledger_unit_count_non_negative_check" CHECK ("unit_count" >= 0) NOT VALID;

ALTER TABLE "settlement"."position_ledger" DROP CONSTRAINT IF EXISTS "position_ledger_cost_basis_eur_non_negative_check";
ALTER TABLE "settlement"."position_ledger"
  ADD CONSTRAINT "position_ledger_cost_basis_eur_non_negative_check" CHECK ("cost_basis_eur" >= 0) NOT VALID;

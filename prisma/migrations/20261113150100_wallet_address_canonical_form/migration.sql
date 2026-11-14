-- One spelling per wallet address: "0x" plus 40 lowercase hex digits.
--
-- settlement.wallet_registrations.wallet_address is TEXT, and TEXT equality is
-- case-sensitive. The API stored whatever spelling the client sent, and the
-- chain watcher compares addresses case-insensitively, so two accounts could
-- hold the same on-chain address in different case and the plain unique index
-- wallet_registrations_wallet_address_key (20260831150000_initial_schema) could
-- not tell. The application now lower-cases at the HTTP edge and in the
-- repositories (src/shared/domain/wallet-address.ts). This migration closes
-- the same hole in the database:
--   1. lower-cases every stored wallet_address, and
--   2. adds CHECK wallet_registrations_wallet_address_lowercase_check
--      (wallet_address = lower(wallet_address)), so no writer can store a
--      second spelling again.
-- With every stored value lower-case, the existing unique index is already
-- case-insensitive, so no lower(wallet_address) index is added here. The
-- CHECK is lower-case only and has no shape test on purpose: existing tests
-- insert non-hex lower-case fixtures; the HTTP edge regex is the shape guard.
-- schema.prisma carries no CHECKs and is not changed.
--
-- WHAT THE MIGRATION REFUSES. If two accounts already hold one address in
-- different case, lower-casing both would violate the unique index. Which
-- account owns an address is not a decision to make inside a migration, so the
-- whole migration fails, changes nothing (Prisma runs the file as one
-- transaction, so rows that would not have collided stay as they were too) and
-- names the colliding lower-case addresses and their claim counts in the error.
-- The message carries no account ids, so nothing personal lands in
-- _prisma_migrations.logs or in CI logs.
--
-- BEFORE DEPLOYING, run this read-only query against the target database.
-- No rows means the migration will not refuse:
--
--   SELECT lower(w.wallet_address) AS canonical_address, w.account_id,
--          w.wallet_address AS stored_spelling, w.requested_at, w.registered_at,
--          w.registration_tx_hash
--   FROM settlement.wallet_registrations w
--   WHERE lower(w.wallet_address) IN (
--           SELECT lower(wallet_address) FROM settlement.wallet_registrations
--           GROUP BY 1 HAVING count(DISTINCT wallet_address) > 1)
--   ORDER BY canonical_address, w.requested_at, w.account_id;
--
-- Rows the migration will rewrite (not a problem, informational):
--
--   SELECT account_id, wallet_address FROM settlement.wallet_registrations
--   WHERE wallet_address <> lower(wallet_address);
--
-- IF THE MIGRATION REFUSES, resolve each colliding group by hand and record it
-- in audit_log (AD-241 wants an audited change to a registered address):
-- normally keep the claim that is registered on chain (registered_at set) and
-- delete the pending one; two registered claims for one on-chain address go to
-- compliance first. Then tell Prisma the failed attempt is done and deploy
-- again (the same file applies once the data is fixed):
--
--   npx prisma migrate resolve --rolled-back 20261113150100_wallet_address_canonical_form
--   npx prisma migrate deploy
--
-- Until that resolve, "prisma migrate deploy" answers P3009 for every later
-- migration. A lock_timeout failure below needs the same resolve step.
--
-- RE-RUNNING. Prisma never re-runs a finished migration. Executing this file
-- by hand twice is a no-op the second time: the UPDATE matches no row and the
-- constraint is dropped and added again.
--
-- LOCKING. The table is locked ACCESS EXCLUSIVE for the length of the
-- transaction (one row per account, so milliseconds). lock_timeout makes it
-- fail fast rather than queue readers behind a long transaction. While the
-- migration is committing, a still-running old container that writes a
-- mixed-case address fails with 23514 until it is replaced.
--
-- ROLLBACK (Prisma has no down migrations). The data stays lower-case; the
-- EIP-55 spelling is derivable from the address, so nothing is lost:
--
--   ALTER TABLE settlement.wallet_registrations
--     DROP CONSTRAINT wallet_registrations_wallet_address_lowercase_check;
--
-- Uses nothing specific to PostgreSQL 18 (LOCK, DO, EXCEPTION, lower, CHECK).
SET LOCAL lock_timeout = '15s';
LOCK TABLE "settlement"."wallet_registrations" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  rewritten integer;
  collision_count integer;
  collisions text;
BEGIN
  UPDATE "settlement"."wallet_registrations"
  SET "wallet_address" = lower("wallet_address")
  WHERE "wallet_address" <> lower("wallet_address");
  GET DIAGNOSTICS rewritten = ROW_COUNT;
  RAISE NOTICE 'wallet_registrations: % wallet address(es) rewritten to lower case', rewritten;
EXCEPTION
  WHEN unique_violation THEN
    -- The failed UPDATE is rolled back with this block, so the rows below are
    -- the original ones.
    SELECT count(*) INTO collision_count
    FROM (
      SELECT 1
      FROM "settlement"."wallet_registrations"
      GROUP BY lower("wallet_address")
      HAVING count(DISTINCT "wallet_address") > 1
    ) AS colliding;
    IF collision_count = 0 THEN
      -- A unique violation that is not a letter-case collision: not ours to
      -- explain, surface it unchanged.
      RAISE;
    END IF;
    SELECT string_agg(
             format('%s (%s claims, %s registered)', canonical_address, claims, registered),
             ', ' ORDER BY canonical_address)
      INTO collisions
    FROM (
      SELECT lower("wallet_address") AS canonical_address,
             count(*) AS claims,
             count("registered_at") AS registered
      FROM "settlement"."wallet_registrations"
      GROUP BY lower("wallet_address")
      HAVING count(DISTINCT "wallet_address") > 1
      ORDER BY lower("wallet_address")
      LIMIT 20
    ) AS listed;
    RAISE EXCEPTION 'wallet_registrations: lower-casing would collide on % address(es) (first 20 listed), each held by different accounts in different letter case: %. Nothing was changed. See the header of 20261113150100_wallet_address_canonical_form for the find query and the resolution steps, then re-run.',
      collision_count, collisions;
END
$$;

ALTER TABLE "settlement"."wallet_registrations"
  DROP CONSTRAINT IF EXISTS "wallet_registrations_wallet_address_lowercase_check";
-- Validated (not NOT VALID): the UPDATE above just lower-cased every row under
-- the same lock, so there is nothing left to be excused.
ALTER TABLE "settlement"."wallet_registrations"
  ADD CONSTRAINT "wallet_registrations_wallet_address_lowercase_check"
  CHECK ("wallet_address" = lower("wallet_address"));

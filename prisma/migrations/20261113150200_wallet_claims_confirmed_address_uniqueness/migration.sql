-- Wallet claims: an address is bound to an account only once it is confirmed.
--
-- settlement.wallet_registrations.registered_at IS NULL is a pending claim: the
-- customer typed an address and nothing has proved they control it. Until now
-- the plain unique index on wallet_address let such a claim reserve the address
-- for good, so a stale or hostile pending row blocked the real owner (#146).
-- The address is now exclusive only among CONFIRMED rows; pending claims are
-- account-scoped and may overlap.
--
-- The index is on lower(wallet_address) because rows written before the
-- canonical lowercase form can still carry EIP-55 mixed case, and
-- 0xAbC... and 0xabc... are one address.
--
-- Find-violators query (read-only; run it before deploying, and again after a
-- failed deploy):
--
--   SELECT lower(wallet_address) AS address,
--          count(*)              AS confirmed_rows,
--          array_agg(account_id ORDER BY registered_at) AS account_ids
--   FROM settlement.wallet_registrations
--   WHERE registered_at IS NOT NULL
--   GROUP BY lower(wallet_address)
--   HAVING count(*) > 1;
--
-- Two accounts both holding a CONFIRMED registration for one address is a
-- KYC-attribution question (which verified person owns the address), not
-- something a migration may settle by picking a row. The check below stops the
-- migration, rolls back everything in it, and leaves both rows untouched.
-- After staff decide, correct the data and re-run `prisma migrate resolve
-- --rolled-back 20261113150200_wallet_claims_confirmed_address_uniqueness`
-- followed by `prisma migrate deploy`. Every statement is idempotent, so a
-- manual re-run of this file after the data is fixed is also safe.
DO $$
DECLARE
  duplicate_addresses integer;
  duplicate_rows integer;
BEGIN
  SELECT count(*), COALESCE(sum(row_count), 0)
    INTO duplicate_addresses, duplicate_rows
  FROM (
    SELECT count(*) AS row_count
    FROM settlement.wallet_registrations
    WHERE registered_at IS NOT NULL
    GROUP BY lower(wallet_address)
    HAVING count(*) > 1
  ) AS duplicates;

  IF duplicate_addresses > 0 THEN
    RAISE EXCEPTION
      'wallet_registrations: % address(es) are held by more than one confirmed registration (% rows)',
      duplicate_addresses, duplicate_rows
      USING
        ERRCODE = 'unique_violation',
        DETAIL = 'A confirmed registration binds an address to one account; this migration will not choose between accounts.',
        HINT = 'Run the find-violators query in this file, have staff decide which account owns each address, correct the other rows, then resolve this migration as rolled back and deploy again.';
  END IF;
END
$$;

DROP INDEX IF EXISTS "settlement"."wallet_registrations_wallet_address_key";

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_registrations_confirmed_address_key"
  ON "settlement"."wallet_registrations" (lower("wallet_address"))
  WHERE "registered_at" IS NOT NULL;

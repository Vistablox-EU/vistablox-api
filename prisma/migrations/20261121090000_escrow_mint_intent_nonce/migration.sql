-- Pin the operator nonce of each escrow mint attempt (#122).
--
-- A mint attempt that recorded no transaction hash used to be retried after a
-- 30-minute grace period once the contributor's balance read zero. Writing the
-- nonce the mint is sent with before sending it lets the next run reconcile
-- against the chain instead: once the operator's confirmed nonce has passed
-- it and no mint log exists, that mint can never land.
--
-- Purely additive: a new nullable column, NULL for every existing row (those
-- attempts keep the time-based rule), and a CHECK that NULL satisfies. No
-- existing row is rewritten or can violate it.

ALTER TABLE "settlement"."escrow_mint_intents"
  ADD COLUMN IF NOT EXISTS "mint_nonce" BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'escrow_mint_intents_mint_nonce_check'
  ) THEN
    ALTER TABLE "settlement"."escrow_mint_intents"
      ADD CONSTRAINT "escrow_mint_intents_mint_nonce_check" CHECK ("mint_nonce" IS NULL OR "mint_nonce" >= 0);
  END IF;
END
$$;

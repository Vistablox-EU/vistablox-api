-- Crash-safe, idempotent AD-256 escrow minting.
--
-- The finalize job mints on-chain and then writes position_ledger +
-- chain_settlement_events. The two cannot share a transaction, and
-- VistaBloxProperty.mint is an unconditional _mint, so a crash or retry
-- between them could mint twice or lose the ledger rows. This adds the
-- durable intent the job writes BEFORE it sends the mint transaction, and a
-- unique link from the position back to that intent so a replay of the
-- recording step cannot create a second position for the same mint.
--
-- Purely additive and safe to apply to a database that already holds data:
--   * escrow_mint_intents is a new, empty table, so none of its constraints can
--     be violated by existing rows (the CHECK constraints are therefore added
--     inline rather than NOT VALID);
--   * position_ledger.escrow_mint_intent_id is a new nullable column, and a
--     unique index over a column that is NULL for every existing row cannot
--     fail (NULLs are distinct in a PostgreSQL unique index);
--   * every statement is idempotent.
-- No existing row is read, rewritten or constrained, so there are no violating
-- rows to look for before applying. Existing escrow-originated positions have
-- no intent and keep working: the finalize job skips any contributor that
-- already has a position.

CREATE TABLE IF NOT EXISTS "settlement"."escrow_mint_intents" (
  "escrow_mint_intent_id" TEXT NOT NULL,
  "piv_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "holder_wallet_address" TEXT NOT NULL,
  "token_contract_address" TEXT NOT NULL,
  "token_id" DECIMAL(78,0) NOT NULL,
  "mint_amount" DECIMAL(78,0) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'sending',
  "mint_tx_hash" TEXT,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "attempted_at" TIMESTAMPTZ(6) NOT NULL,
  "search_from_block" BIGINT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recorded_at" TIMESTAMPTZ(6),

  CONSTRAINT "escrow_mint_intents_pkey" PRIMARY KEY ("escrow_mint_intent_id"),
  CONSTRAINT "escrow_mint_intents_status_check" CHECK ("status" IN ('sending', 'mint_sent', 'recorded')),
  -- Once a transaction hash is known it is never lost: only `sending` may lack one.
  CONSTRAINT "escrow_mint_intents_hash_check" CHECK ("status" = 'sending' OR "mint_tx_hash" IS NOT NULL),
  CONSTRAINT "escrow_mint_intents_recorded_check" CHECK (("status" = 'recorded') = ("recorded_at" IS NOT NULL)),
  CONSTRAINT "escrow_mint_intents_mint_amount_check" CHECK ("mint_amount" > 0),
  CONSTRAINT "escrow_mint_intents_attempt_check" CHECK ("attempt" > 0),
  CONSTRAINT "escrow_mint_intents_piv_id_fkey" FOREIGN KEY ("piv_id") REFERENCES "intake"."pivs"("piv_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "escrow_mint_intents_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- At most one mint intent per contributor per PIV: the database-level anchor
-- that stops two runs (or a replay) from each claiming the same mint.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_escrow_mint_intents_piv_account"
  ON "settlement"."escrow_mint_intents"("piv_id", "account_id");

ALTER TABLE "settlement"."position_ledger"
  ADD COLUMN IF NOT EXISTS "escrow_mint_intent_id" TEXT;

-- At most one position per escrow mint intent.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_position_ledger_escrow_mint_intent"
  ON "settlement"."position_ledger"("escrow_mint_intent_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'position_ledger_escrow_mint_intent_id_fkey'
  ) THEN
    ALTER TABLE "settlement"."position_ledger"
      ADD CONSTRAINT "position_ledger_escrow_mint_intent_id_fkey"
      FOREIGN KEY ("escrow_mint_intent_id") REFERENCES "settlement"."escrow_mint_intents"("escrow_mint_intent_id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

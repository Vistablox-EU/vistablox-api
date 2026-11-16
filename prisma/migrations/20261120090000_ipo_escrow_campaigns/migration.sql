-- #176: gate the funding rail on settlement escrow readiness.
--
-- Records, per Piv, that its AD-256 IPO escrow campaign is open on-chain.
-- settlement.open_ipo_escrow_campaign writes the row after openCampaign is
-- mined (or when campaignOf shows the campaign already opened), and offering
-- reservation creation refuses an offering whose Piv has no row.
--
-- Purely additive: a new, empty table, so its constraints cannot be violated
-- by existing rows, and every statement is idempotent. Existing offerings
-- have no row and stop accepting new reservations until their campaign is
-- opened (fail closed); existing reservations are not touched.

CREATE TABLE IF NOT EXISTS "settlement"."ipo_escrow_campaigns" (
  "piv_id" TEXT NOT NULL,
  "token_id" DECIMAL(78,0) NOT NULL,
  "escrow_contract_address" TEXT NOT NULL,
  "target_amount" DECIMAL(78,0) NOT NULL,
  "deadline_at" TIMESTAMPTZ(6) NOT NULL,
  "treasury_address" TEXT NOT NULL,
  "open_tx_hash" TEXT,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ipo_escrow_campaigns_pkey" PRIMARY KEY ("piv_id"),
  CONSTRAINT "ipo_escrow_campaigns_target_amount_check" CHECK ("target_amount" > 0),
  CONSTRAINT "ipo_escrow_campaigns_piv_id_fkey" FOREIGN KEY ("piv_id") REFERENCES "intake"."pivs"("piv_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ipo_escrow_campaigns_token_id_key" ON "settlement"."ipo_escrow_campaigns"("token_id");

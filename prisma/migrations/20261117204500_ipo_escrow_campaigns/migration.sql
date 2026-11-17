-- #176 (AD-286, decided 2026-11-17): gate reservations on the offering's
-- settlement escrow readiness, where the settlement bundle is configured.
--
-- One row per Piv, recording the LAST OBSERVATION of its AD-256 IPO escrow
-- campaign: the state campaignOf reported, the parameters it reported (target,
-- deadline, treasury, escrow contract) and when it was read (observed_at). It
-- is not "seen open once". An offering is ready only while the row's observed
-- state is 'open' and its deadline_at is still ahead; the operator command that
-- opens campaigns, and the finalizer once it sees the campaign resolved,
-- re-read the chain and move the row to 'successful' or 'failed' (or
-- 'not_opened' when the chain no longer shows it), so the offering stops being
-- ready. A campaign that is not open on-chain has no row, and a pre-existing
-- campaign whose parameters differ from the offering's is never recorded.
--
-- Purely additive: a new, empty table, so its constraints cannot be violated
-- by existing rows, and every statement is idempotent. Existing offerings have
-- no row. Where the settlement bundle is configured they stop taking
-- reservations until an operator opens their campaign; where it is dormant
-- (AD-234) nothing reads this table. Existing reservations are not touched.
--
-- Stamp 20261117204500: later than every migration of this chain
-- (20261117202500 wallet claim expiry, 20261117203000 onramp webhook receipts)
-- and not in the future on the day it was written.

CREATE TABLE IF NOT EXISTS "settlement"."ipo_escrow_campaigns" (
  "piv_id" TEXT NOT NULL,
  "token_id" DECIMAL(78,0) NOT NULL,
  "escrow_contract_address" TEXT NOT NULL,
  "target_amount" DECIMAL(78,0) NOT NULL,
  "deadline_at" TIMESTAMPTZ(6) NOT NULL,
  "treasury_address" TEXT NOT NULL,
  "open_tx_hash" TEXT,
  "observed_state" TEXT NOT NULL,
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ipo_escrow_campaigns_pkey" PRIMARY KEY ("piv_id"),
  CONSTRAINT "ipo_escrow_campaigns_target_amount_check" CHECK ("target_amount" > 0),
  CONSTRAINT "ipo_escrow_campaigns_observed_state_check" CHECK ("observed_state" IN ('not_opened', 'open', 'successful', 'failed')),
  CONSTRAINT "ipo_escrow_campaigns_piv_id_fkey" FOREIGN KEY ("piv_id") REFERENCES "intake"."pivs"("piv_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ipo_escrow_campaigns_token_id_key" ON "settlement"."ipo_escrow_campaigns"("token_id");

-- A position originated directly from an AD-256 IPO escrow contribution has
-- no Reservation row at all -- that model belongs to the separate
-- Stripe/reconfirmation purchase flow (AD-146/AD-214), which an on-chain
-- escrow contribution bypasses entirely. Relaxing this to nullable is purely
-- additive: every existing row already has a reservation_id, and every
-- existing write path continues to set one.
ALTER TABLE "settlement"."position_ledger" ALTER COLUMN "reservation_id" DROP NOT NULL;

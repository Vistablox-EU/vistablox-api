-- Pending wallet claims expire (#177).
--
-- A row with registered_at IS NULL is a pending claim. Until now it stayed
-- pending forever. The worker job maintenance.wallet_registration_expiry now
-- stamps expired_at on a claim still pending WALLET_REGISTRY_PENDING_EXPIRE_AFTER_HOURS
-- after requested_at, and writes an audit row settlement.wallet_registration_expired.
-- An expired claim's commitment is dead: the registry watcher no longer matches
-- it, staff reconcile refuses it, and the customer API reports the account as
-- having no wallet. The row is kept (not deleted) so staff can still see what
-- was claimed; the account's next registration overwrites it in place and
-- clears expired_at.
--
-- Pending now means registered_at IS NULL AND expired_at IS NULL. A row is never
-- both confirmed and expired. Additive and idempotent: existing rows all have
-- expired_at NULL and keep their current state.
ALTER TABLE settlement.wallet_registrations
  ADD COLUMN IF NOT EXISTS expired_at timestamptz(6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wallet_registrations_expired_only_pending_check'
      AND conrelid = 'settlement.wallet_registrations'::regclass
  ) THEN
    ALTER TABLE settlement.wallet_registrations
      ADD CONSTRAINT wallet_registrations_expired_only_pending_check
      CHECK (expired_at IS NULL OR registered_at IS NULL);
  END IF;
END
$$;

-- The expiry job's scan: still-pending claims, oldest first.
CREATE INDEX IF NOT EXISTS idx_wallet_registrations_pending_requested_at
  ON settlement.wallet_registrations (requested_at)
  WHERE registered_at IS NULL AND expired_at IS NULL;

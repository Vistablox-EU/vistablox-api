-- Pending wallet claims expire (#177; AD-287, decided 2026-11-17).
--
-- A row with registered_at IS NULL is a pending claim. Until now it stayed
-- pending forever. The worker job maintenance.wallet_registration_expiry now
-- stamps expired_at on a claim still pending WALLET_REGISTRY_PENDING_EXPIRE_AFTER_HOURS
-- after requested_at, and writes an audit row settlement.wallet_registration_expired.
-- The sweep skips while the registry watcher is stale or lagging.
--
-- An expired claim's commitment is dead for the watcher: a late registry event
-- naming it is counted as unmatched and confirms nothing. The customer API
-- reports the account as having no wallet. Staff can still reconcile the claim
-- on matching on-chain evidence, which confirms it and clears expired_at. The
-- row is kept (never deleted; how long expired rows are retained is not
-- decided); the account's next registration overwrites it in place, needing
-- fresh authentication when the address differs, and clears expired_at.
--
-- Pending now means registered_at IS NULL AND expired_at IS NULL. A row is never
-- both confirmed and expired. Additive and idempotent: existing rows all have
-- expired_at NULL and keep their current state, and every statement below can
-- run again against a database that already has it.
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

-- An enrolled device's biometric key (E2) is recorded as a login method of
-- type device_key, with the device_id as provider_subject. The investing
-- rule requires device_key plus Google or Apple now that customer passkeys
-- are gone.
ALTER TABLE "auth"."login_methods"
  DROP CONSTRAINT "login_methods_supported_method_check";

ALTER TABLE "auth"."login_methods"
  ADD CONSTRAINT "login_methods_supported_method_check"
  CHECK ("method_type" IN ('passkey', 'google', 'apple', 'device_key'));

-- Backfill every active device enrolled before this migration. An account has
-- at most one active device (devices_one_active_per_account). The id is
-- derived from the device_id, which is unique; an account that already has a
-- device_key row keeps it.
INSERT INTO "auth"."login_methods"
  ("login_method_id", "account_id", "method_type", "provider_subject", "linked_at", "linked_via_fresh_auth")
SELECT
  'login_' || d."device_id",
  d."account_id",
  'device_key',
  d."device_id",
  d."created_at",
  true
FROM "auth"."devices" AS d
WHERE d."status" = 'active'
ON CONFLICT DO NOTHING;

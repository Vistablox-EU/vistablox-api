-- Device-bound auth, Phase 4 PR 1 (direct cutover): customers can no longer
-- use passkeys, so the customer "Google/Apple sign-in plus passkey" session
-- level oauth_passkey is removed. Staff passkeys (staff_passkey) are
-- unaffected.
--
-- DESTRUCTIVE. Staging holds only test data, and there is no production
-- database yet.
-- 1. Every auth_session at level oauth_passkey is deleted, which signs those
--    customers out; they re-onboard with Google/Apple and device enrolment.
--    Their auth.sessions mirror rows are marked revoked
--    (revocation_reason 'passkey_cutover').
-- 2. Every passkey credential of a non-staff user is deleted. Staff
--    credentials are kept.
-- 3. The level check constraint no longer allows oauth_passkey.
WITH removed AS (
  DELETE FROM "auth_session" WHERE "authenticationLevel" = 'oauth_passkey' RETURNING "id"
)
UPDATE "auth"."sessions"
SET "status" = 'revoked', "revoked_at" = now(), "revocation_reason" = 'passkey_cutover'
WHERE "better_auth_session_id" IN (SELECT "id" FROM removed) AND "revoked_at" IS NULL;

DELETE FROM "passkey"
WHERE "userId" IN (SELECT "id" FROM "auth_user" WHERE "population" <> 'staff_partner');

ALTER TABLE "auth_session" DROP CONSTRAINT "auth_session_authentication_level_check";

ALTER TABLE "auth_session"
  ADD CONSTRAINT "auth_session_authentication_level_check"
  CHECK ("authenticationLevel" IN ('unassured', 'oauth_pending', 'staff_passkey', 'device_biometric'));

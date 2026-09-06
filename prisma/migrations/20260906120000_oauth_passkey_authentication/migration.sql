-- Customer access is established only after an enabled social provider and
-- a passkey have both succeeded. Existing sessions become unassured and must
-- complete the new login ceremony.
ALTER TABLE "auth_session"
  ADD COLUMN "authenticationLevel" TEXT NOT NULL DEFAULT 'unassured';

ALTER TABLE "auth_session"
  ADD CONSTRAINT "auth_session_authentication_level_check"
  CHECK ("authenticationLevel" IN ('unassured', 'oauth_pending', 'oauth_passkey', 'staff_passkey'));

-- Email OTP is no longer a supported customer identity or recovery factor.
DELETE FROM "account"."login_methods" WHERE "method_type" = 'email_otp';

ALTER TABLE "account"."login_methods"
  ADD CONSTRAINT "login_methods_supported_method_check"
  CHECK ("method_type" IN ('passkey', 'google', 'apple'));

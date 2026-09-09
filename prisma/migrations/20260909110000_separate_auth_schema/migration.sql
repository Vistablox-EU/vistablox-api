-- Carve auth's own tables out of the shared "account" schema into a
-- dedicated "auth" schema -- cheap, metadata-only prep for an eventual
-- physical extraction of auth into its own service, mirroring the
-- microserviced direction the KYC service already took. Auth needs a
-- JWT/JWKS local-verification design before that physical split is safe
-- (session checks sit on the hot path of nearly every protected route);
-- this migration only moves the schema boundary, nothing else. SET SCHEMA
-- relocates each table -- and its indexes/constraints -- without rewriting
-- any data.
CREATE SCHEMA IF NOT EXISTS "auth";

ALTER TABLE "account"."sessions" SET SCHEMA "auth";
ALTER TABLE "account"."staff_invitations" SET SCHEMA "auth";
ALTER TABLE "account"."staff_role_assignments" SET SCHEMA "auth";
ALTER TABLE "account"."staff_webauthn_credentials" SET SCHEMA "auth";
ALTER TABLE "account"."staff_webauthn_challenges" SET SCHEMA "auth";
ALTER TABLE "account"."staff_session_mfa" SET SCHEMA "auth";
ALTER TABLE "account"."login_methods" SET SCHEMA "auth";
ALTER TABLE "account"."mfa_totp_factors" SET SCHEMA "auth";
ALTER TABLE "account"."mfa_backup_codes" SET SCHEMA "auth";
ALTER TABLE "account"."account_recovery_cases" SET SCHEMA "auth";
ALTER TABLE "account"."account_recovery_codes" SET SCHEMA "auth";

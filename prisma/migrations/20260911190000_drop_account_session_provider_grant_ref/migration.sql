-- "sessions" moved from the "account" schema to "auth" in
-- 20260909110000_separate_auth_schema (SET SCHEMA keeps its columns), so the
-- column lives on "auth"."sessions" now.
ALTER TABLE "auth"."sessions"
  DROP COLUMN IF EXISTS "provider_grant_ref";

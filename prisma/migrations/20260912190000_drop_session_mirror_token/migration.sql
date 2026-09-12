-- Better Auth remains the session-token authority. The product session mirror
-- keeps only the provider session ID and resolves a caller-owned token from
-- Better Auth at revocation time.
DROP INDEX IF EXISTS "account"."sessions_better_auth_session_token_key";

ALTER TABLE "account"."sessions"
  DROP COLUMN IF EXISTS "better_auth_session_token";

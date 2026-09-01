-- Needed to call Better Auth's own revoke-session endpoint from the self-
-- service revoke flow, which authorizes by session token, not session id.
ALTER TABLE "account"."sessions" ADD COLUMN "better_auth_session_token" TEXT;

CREATE UNIQUE INDEX "sessions_better_auth_session_token_key"
  ON "account"."sessions"("better_auth_session_token");

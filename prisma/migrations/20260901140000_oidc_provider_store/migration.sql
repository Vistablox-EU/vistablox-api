-- oidc-provider owns this table and accesses it through its own PostgreSQL
-- adapter (src/modules/auth/infrastructure/postgres-oidc-adapter.ts). It is
-- a single generic model store, matching oidc-provider's own documented
-- custom-adapter shape: one row per protocol model instance (Session,
-- Interaction, Grant, AuthorizationCode, AccessToken, RefreshToken, ...),
-- keyed by (model_name, id), with a JSON payload plus the handful of
-- secondary lookup keys oidc-provider's Adapter interface requires.
-- Product-domain code must not query it directly.
CREATE TABLE "oidc_model_instances" (
  "model_name" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "grant_id" TEXT,
  "user_code" TEXT,
  "uid" TEXT,
  "expires_at" TIMESTAMPTZ,
  "consumed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY ("model_name", "id")
);

-- revokeByGrantId spans every model that can belong to a grant
-- (AccessToken, AuthorizationCode, RefreshToken, ...), so this index is
-- intentionally not scoped to model_name.
CREATE INDEX "oidc_model_instances_grant_id_idx"
  ON "oidc_model_instances"("grant_id")
  WHERE "grant_id" IS NOT NULL;

CREATE UNIQUE INDEX "oidc_model_instances_user_code_uidx"
  ON "oidc_model_instances"("model_name", "user_code")
  WHERE "user_code" IS NOT NULL;

CREATE UNIQUE INDEX "oidc_model_instances_uid_uidx"
  ON "oidc_model_instances"("model_name", "uid")
  WHERE "uid" IS NOT NULL;

-- Supports the periodic cleanup sweep in the pg-boss worker; NULL means
-- "never expires" (registered clients) and is intentionally excluded.
CREATE INDEX "oidc_model_instances_expires_at_idx"
  ON "oidc_model_instances"("expires_at")
  WHERE "expires_at" IS NOT NULL;

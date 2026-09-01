-- AD-120/AD-128: the shared secret must remain reversible to compute a live
-- TOTP code, so it is stored as plaintext here rather than hashed; phase 1
-- relies on storage/transport-level encryption only.
CREATE TABLE "account"."mfa_totp_factors" (
  "account_id" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "enrolled_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMPTZ,

  CONSTRAINT "mfa_totp_factors_pkey" PRIMARY KEY ("account_id")
);

-- AD-177: backup codes are hashed and marked consumed-on-use, mirroring
-- password-storage discipline rather than the TOTP secret's plaintext posture.
CREATE TABLE "account"."mfa_backup_codes" (
  "backup_code_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumed_at" TIMESTAMPTZ,

  CONSTRAINT "mfa_backup_codes_pkey" PRIMARY KEY ("backup_code_id")
);

CREATE UNIQUE INDEX "mfa_backup_codes_account_code_key"
  ON "account"."mfa_backup_codes"("account_id", "code_hash");
CREATE INDEX "idx_mfa_backup_codes_account"
  ON "account"."mfa_backup_codes"("account_id");

ALTER TABLE "account"."mfa_totp_factors"
  ADD CONSTRAINT "mfa_totp_factors_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "account"."mfa_backup_codes"
  ADD CONSTRAINT "mfa_backup_codes_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

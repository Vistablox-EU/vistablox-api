CREATE TABLE "account"."account_recovery_codes" (
  "account_id" TEXT NOT NULL PRIMARY KEY,
  "code_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumed_at" TIMESTAMPTZ,
  CONSTRAINT "account_recovery_codes_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

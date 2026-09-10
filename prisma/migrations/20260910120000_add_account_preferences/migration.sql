CREATE TABLE "account"."account_preferences" (
  "account_id" TEXT NOT NULL PRIMARY KEY,
  "deal_alerts_email" BOOLEAN NOT NULL DEFAULT true,
  "statements_email" BOOLEAN NOT NULL DEFAULT true,
  "marketing_email" BOOLEAN NOT NULL DEFAULT false,
  "locale" TEXT NOT NULL DEFAULT 'en-US',
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_preferences_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

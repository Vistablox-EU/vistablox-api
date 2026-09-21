-- Self-service device replacement (AD-271): one short-lived, single-use email
-- code per account authorizes revoking the active device + device_key login
-- method so the customer can enrol a new device after a reinstall or new
-- phone, with no staff and no SMS. Stores only the code HASH, never the
-- plaintext. The "at most one pending code per account" invariant is enforced
-- in DeviceReplacementCodeRepository.revokePendingForAccount rather than a
-- partial unique index here: the pending predicate depends on expires_at,
-- which a static index cannot express.
CREATE TABLE "auth"."device_replacement_codes" (
  "device_replacement_code_id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "session_id" TEXT,
  "code_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "attempts_used" INTEGER NOT NULL DEFAULT 0,
  "consumed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_replacement_codes_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "idx_device_replacement_codes_account"
  ON "auth"."device_replacement_codes" ("account_id", "consumed_at");

CREATE INDEX "idx_device_replacement_codes_expiry"
  ON "auth"."device_replacement_codes" ("expires_at");

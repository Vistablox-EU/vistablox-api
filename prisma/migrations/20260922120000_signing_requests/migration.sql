-- Per-action signing requests (T1-T3). One row per sensitive action awaiting
-- the device's biometric signature; the request_id is the canonical
-- reference the device signs over (AD-097), amounts are decimal strings, and
-- the tx claims are compared to this row field by field -- any difference is
-- TX_FIELD_MISMATCH. Off-chain request types store the compact JWS the device
-- returned in signed_jws; status moves pending -> signed -> executed, with
-- pending/signed -> expired by the hourly prune and pending/signed ->
-- cancelled when the device is revoked. user_op/signed_user_op/user_op_hash
-- (on-chain request types) are deliberately not columns yet -- those land
-- with the Safe/bundler work, avoiding dead nullable columns until this
-- table actually needs them.
CREATE TABLE "auth"."signing_requests" (
  "signing_request_id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "device_id" TEXT NOT NULL,
  "request_type" TEXT NOT NULL,
  "amount_minor" TEXT,
  "currency" TEXT,
  "destination" JSONB,
  "created_by" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "signed_jws" JSONB,
  "signed_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "signing_requests_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "signing_requests_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "auth"."devices"("device_id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "idx_signing_requests_account_status_created"
  ON "auth"."signing_requests" ("account_id", "status", "created_at");
CREATE INDEX "idx_signing_requests_expires_at"
  ON "auth"."signing_requests" ("expires_at");
CREATE INDEX "idx_signing_requests_device_status"
  ON "auth"."signing_requests" ("device_id", "status");

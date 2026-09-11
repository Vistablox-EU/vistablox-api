-- Device-key auth, step 1: single-device enrolment/login. owner_address,
-- owner_status, hold_until and push_token are deliberately not columns yet
-- -- they land with the Safe/pairing/push work, avoiding dead nullable
-- columns until this table actually needs them.
CREATE TABLE "auth"."devices" (
  "device_id" TEXT NOT NULL PRIMARY KEY,
  "account_id" TEXT NOT NULL,
  "better_auth_user_id" TEXT NOT NULL,
  "dpop_jkt" TEXT NOT NULL,
  "bio_jkt" TEXT NOT NULL,
  "biometric_public_jwk" JSONB NOT NULL,
  "platform" TEXT NOT NULL,
  "model" TEXT,
  "os_version" TEXT,
  "app_version" TEXT,
  "attestation_metadata" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "devices_dpop_jkt_key" UNIQUE ("dpop_jkt"),
  CONSTRAINT "devices_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "idx_devices_account" ON "auth"."devices" ("account_id");

-- Single-use challenges for the device-auth JWS ceremony. Consumed
-- atomically via a conditional UPDATE ... SET consumed_at = now() WHERE
-- consumed_at IS NULL, mirroring dpop_replays' insert-once atomicity but for
-- a server-issued value instead of one the client picks.
CREATE TABLE "auth"."device_challenges" (
  "challenge" TEXT NOT NULL PRIMARY KEY,
  "purpose" TEXT NOT NULL,
  "dpop_jkt" TEXT NOT NULL,
  "device_id" TEXT,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "consumed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "idx_device_challenges_expires_at" ON "auth"."device_challenges" ("expires_at");

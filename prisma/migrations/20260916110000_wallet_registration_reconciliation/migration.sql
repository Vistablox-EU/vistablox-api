ALTER TABLE "settlement"."wallet_registrations"
  ADD COLUMN "registration_tx_hash" TEXT,
  ADD COLUMN "registration_block_number" BIGINT;

CREATE UNIQUE INDEX "wallet_registrations_registration_tx_hash_key"
  ON "settlement"."wallet_registrations"("registration_tx_hash")
  WHERE "registration_tx_hash" IS NOT NULL;

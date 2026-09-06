-- VistaBlox authentication is passwordless. Better Auth keeps the nullable
-- password column as part of its vendor schema, but application data may no
-- longer populate it or retain credential-provider accounts.
DELETE FROM "auth_account" WHERE "providerId" = 'credential';
UPDATE "auth_account" SET "password" = NULL WHERE "password" IS NOT NULL;

DELETE FROM "account"."login_methods" WHERE "method_type" = 'email_password';

ALTER TABLE "auth_account"
  ADD CONSTRAINT "auth_account_passwordless_check"
  CHECK ("providerId" <> 'credential' AND "password" IS NULL);

CREATE TABLE "passkey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT,
  "publicKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "auth_user"("id") ON DELETE CASCADE,
  "credentialID" TEXT NOT NULL,
  "counter" INTEGER NOT NULL,
  "deviceType" TEXT NOT NULL,
  "backedUp" BOOLEAN NOT NULL,
  "transports" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "aaguid" TEXT
);

CREATE UNIQUE INDEX "passkey_userId_uidx" ON "passkey"("userId");
CREATE UNIQUE INDEX "passkey_credentialID_uidx" ON "passkey"("credentialID");

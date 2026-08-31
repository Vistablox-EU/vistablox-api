-- Better Auth owns these tables and accesses them through its PostgreSQL
-- adapter. Product-domain code must not query them directly.
CREATE TABLE "auth_user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL,
  "image" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "population" TEXT NOT NULL,

  CONSTRAINT "auth_user_population_check"
    CHECK ("population" IN ('customer', 'staff_partner'))
);

CREATE TABLE "auth_session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "auth_user"("id") ON DELETE CASCADE
);

CREATE TABLE "auth_account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "issuer" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "auth_user"("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMPTZ,
  "refreshTokenExpiresAt" TIMESTAMPTZ,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL
);

CREATE TABLE "auth_verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "auth_session_userId_idx" ON "auth_session"("userId");
CREATE INDEX "auth_account_userId_idx" ON "auth_account"("userId");
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification"("identifier");
CREATE UNIQUE INDEX "auth_account_issuer_accountId_uidx"
  ON "auth_account"("issuer", "accountId");

ALTER TABLE "account"."accounts"
  ADD CONSTRAINT "accounts_better_auth_user_id_fkey"
  FOREIGN KEY ("better_auth_user_id") REFERENCES "auth_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

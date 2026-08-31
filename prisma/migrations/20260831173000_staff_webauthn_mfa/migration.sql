CREATE TABLE "account"."staff_webauthn_credentials" (
  "credential_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "public_key" BYTEA NOT NULL,
  "counter" BIGINT NOT NULL DEFAULT 0,
  "device_type" TEXT NOT NULL,
  "backed_up" BOOLEAN NOT NULL DEFAULT false,
  "transports" TEXT[] NOT NULL,
  "label" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMPTZ,

  CONSTRAINT "staff_webauthn_credentials_pkey" PRIMARY KEY ("credential_id"),
  CONSTRAINT "staff_webauthn_credentials_counter_check" CHECK ("counter" >= 0),
  CONSTRAINT "staff_webauthn_credentials_device_type_check"
    CHECK ("device_type" IN ('singleDevice', 'multiDevice'))
);

CREATE TABLE "account"."staff_webauthn_challenges" (
  "challenge_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "provider_session_id" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "challenge" TEXT NOT NULL,
  "credential_label" TEXT,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "used_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "staff_webauthn_challenges_pkey" PRIMARY KEY ("challenge_id"),
  CONSTRAINT "staff_webauthn_challenges_purpose_check"
    CHECK ("purpose" IN ('registration', 'authentication')),
  CONSTRAINT "staff_webauthn_challenges_expiry_check"
    CHECK ("expires_at" > "created_at")
);

CREATE TABLE "account"."staff_session_mfa" (
  "provider_session_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "credential_id" TEXT NOT NULL,
  "verified_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "staff_session_mfa_pkey" PRIMARY KEY ("provider_session_id")
);

CREATE INDEX "idx_staff_webauthn_credentials_account"
  ON "account"."staff_webauthn_credentials"("account_id");
CREATE UNIQUE INDEX "staff_webauthn_challenges_challenge_key"
  ON "account"."staff_webauthn_challenges"("challenge");
CREATE INDEX "idx_staff_webauthn_challenges_session"
  ON "account"."staff_webauthn_challenges"("account_id", "provider_session_id", "purpose");
CREATE INDEX "idx_staff_webauthn_challenges_expiry"
  ON "account"."staff_webauthn_challenges"("expires_at");
CREATE INDEX "idx_staff_session_mfa_account"
  ON "account"."staff_session_mfa"("account_id");
CREATE INDEX "idx_staff_session_mfa_credential"
  ON "account"."staff_session_mfa"("credential_id");

ALTER TABLE "account"."staff_webauthn_credentials"
  ADD CONSTRAINT "staff_webauthn_credentials_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account"."staff_webauthn_challenges"
  ADD CONSTRAINT "staff_webauthn_challenges_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account"."staff_webauthn_challenges"
  ADD CONSTRAINT "staff_webauthn_challenges_provider_session_id_fkey"
  FOREIGN KEY ("provider_session_id") REFERENCES "auth_session"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account"."staff_session_mfa"
  ADD CONSTRAINT "staff_session_mfa_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "account"."accounts"("account_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account"."staff_session_mfa"
  ADD CONSTRAINT "staff_session_mfa_credential_id_fkey"
  FOREIGN KEY ("credential_id") REFERENCES "account"."staff_webauthn_credentials"("credential_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "account"."staff_session_mfa"
  ADD CONSTRAINT "staff_session_mfa_provider_session_id_fkey"
  FOREIGN KEY ("provider_session_id") REFERENCES "auth_session"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

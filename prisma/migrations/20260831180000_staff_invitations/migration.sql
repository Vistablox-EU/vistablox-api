CREATE TABLE "account"."staff_invitations" (
  "invitation_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "legal_practice_id" TEXT,
  "appraisal_firm_id" TEXT,
  "token_hash" TEXT NOT NULL,
  "invited_by_account_id" TEXT NOT NULL,
  "accepted_account_id" TEXT,
  "claim_id" TEXT,
  "claimed_at" TIMESTAMPTZ,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "accepted_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "staff_invitations_pkey" PRIMARY KEY ("invitation_id"),
  CONSTRAINT "staff_invitations_email_normalized_check" CHECK ("email" = lower("email")),
  CONSTRAINT "staff_invitations_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "staff_invitations_acceptance_check" CHECK (
    ("accepted_at" IS NULL AND "accepted_account_id" IS NULL) OR
    ("accepted_at" IS NOT NULL AND "accepted_account_id" IS NOT NULL)
  ),
  CONSTRAINT "staff_invitations_role_scope_check" CHECK (
    ("role" = 'legal_partner' AND "legal_practice_id" IS NOT NULL AND "appraisal_firm_id" IS NULL) OR
    ("role" = 'appraisal_partner' AND "appraisal_firm_id" IS NOT NULL AND "legal_practice_id" IS NULL) OR
    ("role" = 'admin_operations' AND "legal_practice_id" IS NULL AND "appraisal_firm_id" IS NULL)
  )
);

CREATE UNIQUE INDEX "staff_invitations_token_hash_key"
  ON "account"."staff_invitations"("token_hash");
CREATE UNIQUE INDEX "staff_invitations_accepted_account_id_key"
  ON "account"."staff_invitations"("accepted_account_id");
CREATE UNIQUE INDEX "staff_invitations_one_pending_email_key"
  ON "account"."staff_invitations"("email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
CREATE INDEX "idx_staff_invitations_email"
  ON "account"."staff_invitations"("email");
CREATE INDEX "idx_staff_invitations_expiry"
  ON "account"."staff_invitations"("expires_at");
CREATE INDEX "idx_staff_invitations_invited_by"
  ON "account"."staff_invitations"("invited_by_account_id");

ALTER TABLE "account"."staff_invitations"
  ADD CONSTRAINT "staff_invitations_invited_by_account_id_fkey"
  FOREIGN KEY ("invited_by_account_id") REFERENCES "account"."accounts"("account_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "account"."staff_invitations"
  ADD CONSTRAINT "staff_invitations_accepted_account_id_fkey"
  FOREIGN KEY ("accepted_account_id") REFERENCES "account"."accounts"("account_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "account"."staff_invitations"
  ADD CONSTRAINT "staff_invitations_legal_practice_id_fkey"
  FOREIGN KEY ("legal_practice_id") REFERENCES "origination"."legal_practices"("legal_practice_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "account"."staff_invitations"
  ADD CONSTRAINT "staff_invitations_appraisal_firm_id_fkey"
  FOREIGN KEY ("appraisal_firm_id") REFERENCES "origination"."appraisal_firms"("appraisal_firm_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

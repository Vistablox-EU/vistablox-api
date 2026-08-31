ALTER TABLE "auth_user"
  ADD COLUMN "disabledAt" TIMESTAMPTZ,
  ADD COLUMN "disabledReason" TEXT,
  ADD COLUMN "recoveryRequiredAt" TIMESTAMPTZ;

ALTER TABLE "auth_user"
  ADD CONSTRAINT "auth_user_disabled_state_check"
  CHECK (
    ("disabledAt" IS NULL AND "disabledReason" IS NULL)
    OR
    (
      "disabledAt" IS NOT NULL
      AND "disabledReason" IN (
        'employment_ended',
        'partner_firm_notice',
        'security_action'
      )
    )
  ),
  ADD CONSTRAINT "auth_user_staff_lifecycle_population_check"
  CHECK (
    "population" = 'staff_partner'
    OR
    (
      "disabledAt" IS NULL
      AND "disabledReason" IS NULL
      AND "recoveryRequiredAt" IS NULL
    )
  );

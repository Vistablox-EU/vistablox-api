-- Customer account recovery sets auth_user."recoveryRequiredAt" when a
-- staff-reviewed case opens (BetterAuthCustomerAccountAdministrator.
-- revokeAllSessions) and clears it when the case completes. The original
-- staff-lifecycle constraint (20260831190000_staff_account_lifecycle) allowed
-- recoveryRequiredAt only on staff_partner users, so opening a customer case
-- failed this CHECK against Postgres. The disable columns stay staff-only;
-- recoveryRequiredAt is allowed for every population.
ALTER TABLE "auth_user"
  DROP CONSTRAINT "auth_user_staff_lifecycle_population_check";

ALTER TABLE "auth_user"
  ADD CONSTRAINT "auth_user_staff_lifecycle_population_check"
  CHECK (
    "population" = 'staff_partner'
    OR
    (
      "disabledAt" IS NULL
      AND "disabledReason" IS NULL
    )
  );

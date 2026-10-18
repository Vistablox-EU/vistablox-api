-- 20260917150000_rename_origination_to_intake renamed the schema and the case
-- table but not the platform.settings keys, while PrismaIntakeRepository now
-- reads the intake.* spellings (and throws "Missing ... setting" when a row is
-- absent). A database built purely from migrations therefore had none of the
-- three rows, so draft creation, information-request publication and the
-- reminder timer all failed on a fresh environment. CI stayed green because no
-- real-database test read these settings.
--
-- Rename the three keys. The new rows are inserted first, carrying over the
-- existing value, description and last-changed provenance (updated_at /
-- updated_by), so a value an operator already changed survives as it was.
-- ON CONFLICT DO NOTHING keeps this safe to apply to an environment that was
-- patched by hand: an intake.* row that already exists wins, and only the stale
-- origination.* row is dropped. Nothing reads the origination.* spellings any
-- more.
INSERT INTO "platform"."settings" ("setting_key", "value", "description", "updated_at", "updated_by")
SELECT
  "renamed"."new_key",
  "existing"."value",
  "existing"."description",
  "existing"."updated_at",
  "existing"."updated_by"
FROM (
  VALUES
    ('origination.minimum_property_value_eur', 'intake.minimum_property_value_eur'),
    ('origination.applicant_response_window_business_days', 'intake.applicant_response_window_business_days'),
    ('origination.information_request_reminder_business_days', 'intake.information_request_reminder_business_days')
) AS "renamed" ("old_key", "new_key")
JOIN "platform"."settings" AS "existing"
  ON "existing"."setting_key" = "renamed"."old_key"
ON CONFLICT ("setting_key") DO NOTHING;

DELETE FROM "platform"."settings"
WHERE "setting_key" IN (
  'origination.minimum_property_value_eur',
  'origination.applicant_response_window_business_days',
  'origination.information_request_reminder_business_days'
);

INSERT INTO "platform"."settings" (
  "setting_key",
  "value",
  "description"
) VALUES (
  'origination.minimum_property_value_eur',
  '{"amount":"150000.00","currency":"EUR"}'::jsonb,
  'Phase-1 owner-declared property-value floor from AD-097/AD-184. Review the legal and unit-economics basis before changing.'
)
ON CONFLICT ("setting_key") DO NOTHING;

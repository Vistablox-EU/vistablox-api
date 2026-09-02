INSERT INTO "platform"."settings" (
  "setting_key",
  "value",
  "description"
) VALUES (
  'offering.reconfirmation_reminder_interval_hours',
  '{"hours":48}'::jsonb,
  'Hours between reconfirmation-window reminder emails while a reservation stays awaiting_reconfirmation, per AD-214''s reminder cadence rule.'
)
ON CONFLICT ("setting_key") DO NOTHING;

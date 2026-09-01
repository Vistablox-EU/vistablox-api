INSERT INTO "platform"."settings" (
  "setting_key",
  "value",
  "description"
) VALUES (
  'origination.information_request_reminder_business_days',
  '{"business_days":[3,7]}'::jsonb,
  'Elapsed business days after publishing an information request at which an applicant reminder is sent, per AD-193''s day-3/day-7 cadence.'
), (
  'identity.kyc_renewal_reminder_lead_days',
  '{"days":30}'::jsonb,
  'Calendar days before identity.kyc_eligibility.renewal_due_at at which a renewal reminder is sent, per AD-213.'
)
ON CONFLICT ("setting_key") DO NOTHING;

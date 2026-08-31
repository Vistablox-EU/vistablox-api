INSERT INTO "platform"."settings" (
  "setting_key",
  "value",
  "description"
) VALUES (
  'origination.applicant_response_window_business_days',
  '{"business_days":10}'::jsonb,
  'Standard applicant response window for published information requests from AD-047/AD-149/AD-184.'
)
ON CONFLICT ("setting_key") DO NOTHING;

ALTER TABLE "origination"."origination_cases"
ADD CONSTRAINT "origination_cases_stage_check"
CHECK (
  "stage" IN (
    'draft',
    'submitted',
    'waiting_on_applicant',
    'pre_offering_open',
    'post_ipo_structuring',
    'approved_for_final_offering',
    'rejected',
    'withdrawn',
    'expired'
  )
);

ALTER TABLE "origination"."origination_cases"
ADD CONSTRAINT "origination_cases_ipo_terms_check"
CHECK (
  ("ipo_period_days" IS NULL OR "ipo_period_days" > 0) AND
  ("ipo_value_eur" IS NULL OR "ipo_value_eur" > 0)
);

ALTER TABLE "origination"."submission_revisions"
ADD CONSTRAINT "submission_revisions_number_check"
CHECK ("revision_number" > 0);

ALTER TABLE "origination"."submission_revisions"
ADD CONSTRAINT "submission_revisions_reason_check"
CHECK ("reason" IN ('initial', 'resubmission_after_rfi'));

ALTER TABLE "origination"."documentary_screening_evidence"
ADD CONSTRAINT "documentary_screening_evidence_status_check"
CHECK ("status" IN ('pending', 'mandatory_missing', 'accepted', 'rejected'));

ALTER TABLE "origination"."information_requests"
ADD CONSTRAINT "information_requests_workstream_check"
CHECK ("requesting_workstream" IN ('legal', 'appraisal', 'origination'));

ALTER TABLE "origination"."information_requests"
ADD CONSTRAINT "information_requests_status_check"
CHECK ("status" IN ('proposed', 'published', 'answered', 'withdrawn', 'expired'));

ALTER TABLE "origination"."information_requests"
ADD CONSTRAINT "information_requests_resolution_check"
CHECK (
  (
    "status" IN ('proposed', 'published') AND
    "resolution_type" IS NULL AND
    "resolved_at" IS NULL AND
    "resolving_revision_id" IS NULL
  ) OR (
    "status" = 'answered' AND
    "resolution_type" = 'resubmitted' AND
    "resolved_at" IS NOT NULL AND
    "resolving_revision_id" IS NOT NULL
  ) OR (
    "status" = 'withdrawn' AND
    "resolution_type" = 'withdrawn' AND
    "resolved_at" IS NOT NULL AND
    "resolving_revision_id" IS NULL
  ) OR (
    "status" = 'expired' AND
    "resolution_type" = 'expired' AND
    "resolved_at" IS NOT NULL AND
    "resolving_revision_id" IS NULL
  )
);

ALTER TABLE "origination"."information_requests"
ADD CONSTRAINT "information_requests_publication_check"
CHECK (
  "status" = 'proposed' OR
  ("published_by_account_id" IS NOT NULL AND "published_at" IS NOT NULL AND "due_at" IS NOT NULL)
);

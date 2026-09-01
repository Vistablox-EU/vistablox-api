ALTER TABLE "identity"."kyc_eligibility"
  ADD COLUMN "provider_status" TEXT,
  ADD COLUMN "operational_substatus" TEXT NOT NULL DEFAULT 'kyc_not_started',
  ADD COLUMN "provider_updated_at" TIMESTAMPTZ,
  ADD COLUMN "session_start_id" TEXT;

UPDATE "identity"."kyc_eligibility"
SET "operational_substatus" = CASE "eligibility_state"
  WHEN 'in_progress' THEN 'kyc_pending'
  WHEN 'pending_manual_review' THEN 'kyc_manual_review'
  WHEN 'eligible' THEN 'kyc_verified_owner_poa_missing'
  WHEN 'unsupported_jurisdiction' THEN 'kyc_jurisdiction_blocked'
  WHEN 'not_eligible' THEN 'kyc_failed'
  WHEN 'requires_renewal' THEN 'kyc_reverification_required'
  WHEN 'suspended_restricted' THEN 'kyc_restricted'
  ELSE 'kyc_not_started'
END;

CREATE UNIQUE INDEX "kyc_eligibility_didit_reference_key"
  ON "identity"."kyc_eligibility"("didit_reference");

CREATE UNIQUE INDEX "kyc_eligibility_session_start_id_key"
  ON "identity"."kyc_eligibility"("session_start_id");

ALTER TABLE "identity"."kyc_eligibility"
  ADD CONSTRAINT "kyc_eligibility_state_check"
  CHECK (
    "eligibility_state" IN (
      'not_started',
      'in_progress',
      'pending_manual_review',
      'eligible',
      'unsupported_jurisdiction',
      'not_eligible',
      'requires_renewal',
      'suspended_restricted'
    )
  ),
  ADD CONSTRAINT "kyc_operational_substatus_check"
  CHECK (
    "operational_substatus" IN (
      'kyc_not_started',
      'kyc_session_creating',
      'kyc_session_creation_failed',
      'kyc_session_open',
      'kyc_pending',
      'kyc_resubmission_pending',
      'kyc_manual_review',
      'kyc_verified_pending_policy_eval',
      'kyc_verified',
      'kyc_verified_owner_poa_missing',
      'kyc_jurisdiction_blocked',
      'kyc_failed',
      'kyc_restart_required',
      'kyc_reverification_required',
      'kyc_restricted',
      'kyc_integration_anomaly'
    )
  ),
  ADD CONSTRAINT "kyc_residence_country_code_check"
  CHECK (
    "residence_country_code" IS NULL
    OR "residence_country_code" ~ '^[A-Z]{2}$'
  ),
  ADD CONSTRAINT "kyc_tax_residence_country_code_check"
  CHECK (
    "tax_residence_country_code" IS NULL
    OR "tax_residence_country_code" ~ '^[A-Z]{2}$'
  ),
  ADD CONSTRAINT "kyc_provider_status_check"
  CHECK (
    "provider_status" IS NULL
    OR "provider_status" IN (
      'Not Started',
      'In Progress',
      'In Review',
      'Approved',
      'Declined',
      'Resubmitted',
      'Expired',
      'Abandoned',
      'Kyc Expired',
      'Awaiting User'
    )
  );

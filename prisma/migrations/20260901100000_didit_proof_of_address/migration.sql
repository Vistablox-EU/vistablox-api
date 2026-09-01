ALTER TABLE "identity"."kyc_eligibility"
  ADD COLUMN "proof_of_address_didit_reference" TEXT,
  ADD COLUMN "proof_of_address_provider_status" TEXT,
  ADD COLUMN "proof_of_address_provider_updated_at" TIMESTAMPTZ,
  ADD COLUMN "proof_of_address_session_start_id" TEXT,
  ADD COLUMN "proof_of_address_status" TEXT NOT NULL DEFAULT 'not_started';

UPDATE "identity"."kyc_eligibility"
SET "proof_of_address_status" = CASE
  WHEN "proof_of_address_current_until" > now() THEN 'current'
  WHEN "proof_of_address_current_until" IS NOT NULL THEN 'expired'
  ELSE 'not_started'
END;

CREATE UNIQUE INDEX "kyc_eligibility_poa_didit_reference_key"
  ON "identity"."kyc_eligibility"("proof_of_address_didit_reference");

CREATE UNIQUE INDEX "kyc_eligibility_poa_session_start_id_key"
  ON "identity"."kyc_eligibility"("proof_of_address_session_start_id");

ALTER TABLE "identity"."kyc_eligibility"
  ADD CONSTRAINT "kyc_proof_of_address_provider_status_check"
  CHECK (
    "proof_of_address_provider_status" IS NULL
    OR "proof_of_address_provider_status" IN (
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
  ),
  ADD CONSTRAINT "kyc_proof_of_address_status_check"
  CHECK (
    "proof_of_address_status" IN (
      'not_started',
      'creating',
      'creation_failed',
      'in_progress',
      'pending_manual_review',
      'current',
      'insufficient',
      'expired',
      'restart_required',
      'integration_anomaly'
    )
  ),
  ADD CONSTRAINT "kyc_proof_of_address_current_until_check"
  CHECK (
    "proof_of_address_status" <> 'current'
    OR "proof_of_address_current_until" IS NOT NULL
  );

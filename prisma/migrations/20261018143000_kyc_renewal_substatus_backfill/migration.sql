-- The KYC renewal due-date job used to move an eligible customer
-- to requires_renewal without touching operational_substatus, so the row kept
-- kyc_verified / kyc_verified_owner_poa_missing and canStartSession refused
-- every restart (POST /v1/kyc/sessions answered 409). The code now sets the
-- sub-status with the state; this fixes the rows the old code already moved,
-- the same pairing 20260901090000_didit_kyc backfilled. Proof-of-address
-- state lives in its own columns and is not affected.
UPDATE "identity"."kyc_eligibility"
SET "operational_substatus" = 'kyc_reverification_required'
WHERE "eligibility_state" = 'requires_renewal'
  AND "operational_substatus" IN ('kyc_verified', 'kyc_verified_owner_poa_missing');

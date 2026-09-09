-- Phase 7: event-driven local copies of KycEligibilitySnapshot for
-- origination, offering, and investor-profile (parked in "account", which
-- has no dedicated schema of its own). Deliberately no foreign key to
-- account.accounts -- see the schema.prisma comment on each model for why.
CREATE TABLE "origination"."kyc_eligibility_projection" (
  "account_id" TEXT NOT NULL PRIMARY KEY,
  "didit_reference" TEXT,
  "provider_status" TEXT,
  "eligibility_state" TEXT NOT NULL,
  "residence_country_code" TEXT,
  "tax_residence_country_code" TEXT,
  "proof_of_address_status" TEXT NOT NULL,
  "proof_of_address_current_until" TIMESTAMPTZ,
  "last_verified_at" TIMESTAMPTZ,
  "renewal_due_at" TIMESTAMPTZ,
  "projection_updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "offering"."kyc_eligibility_projection" (
  "account_id" TEXT NOT NULL PRIMARY KEY,
  "didit_reference" TEXT,
  "provider_status" TEXT,
  "eligibility_state" TEXT NOT NULL,
  "residence_country_code" TEXT,
  "tax_residence_country_code" TEXT,
  "proof_of_address_status" TEXT NOT NULL,
  "proof_of_address_current_until" TIMESTAMPTZ,
  "last_verified_at" TIMESTAMPTZ,
  "renewal_due_at" TIMESTAMPTZ,
  "projection_updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "account"."kyc_eligibility_projection" (
  "account_id" TEXT NOT NULL PRIMARY KEY,
  "didit_reference" TEXT,
  "provider_status" TEXT,
  "eligibility_state" TEXT NOT NULL,
  "residence_country_code" TEXT,
  "tax_residence_country_code" TEXT,
  "proof_of_address_status" TEXT NOT NULL,
  "proof_of_address_current_until" TIMESTAMPTZ,
  "last_verified_at" TIMESTAMPTZ,
  "renewal_due_at" TIMESTAMPTZ,
  "projection_updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

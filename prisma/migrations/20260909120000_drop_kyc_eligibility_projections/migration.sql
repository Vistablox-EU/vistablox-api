-- Reversal (undoing the KYC microservice split): origination, offering, and
-- investor-profile read identity.kyc_eligibility directly again instead of
-- through their own event-driven local copy, so these three projection
-- tables (created together in 20260909100000_kyc_eligibility_projections)
-- have no reader or writer left. This migration has only ever reached
-- disposable local/CI Postgres instances, never staging or production.
DROP TABLE "origination"."kyc_eligibility_projection";
DROP TABLE "offering"."kyc_eligibility_projection";
DROP TABLE "account"."kyc_eligibility_projection";

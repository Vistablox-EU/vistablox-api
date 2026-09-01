-- KYC_WORKFLOW.md's renewal policy sets a 24-month interval for low-risk
-- supported-jurisdiction retail customers but 12 months for "higher-risk or
-- manually reviewed" ones. This is the persisted signal that distinguishes
-- them: true once an account's operational_substatus has ever resolved to
-- kyc_manual_review, even if a later decision clears it to kyc_verified.
-- Monotonic by design (never reset back to false) -- a past manual-review
-- outcome is a permanent phase-1 risk marker, not a rolling window.
ALTER TABLE "identity"."kyc_eligibility"
  ADD COLUMN "ever_required_manual_review" BOOLEAN NOT NULL DEFAULT false;

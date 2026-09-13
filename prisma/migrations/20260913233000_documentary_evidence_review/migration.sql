-- Staff can now record a review decision on a submitted evidence document.
-- Purely advisory (documentary_screening_evidence.status is not read by any
-- gating logic today, and this doesn't change that) -- so no stage
-- restriction is enforced here, only internal consistency between status
-- and the reviewer fields.
ALTER TABLE "origination"."documentary_screening_evidence"
  ADD COLUMN "reviewed_by_account_id" TEXT,
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN "review_notes" TEXT;

ALTER TABLE "origination"."documentary_screening_evidence"
  ADD CONSTRAINT "documentary_screening_evidence_reviewed_by_account_id_fkey"
  FOREIGN KEY ("reviewed_by_account_id") REFERENCES "account"."accounts"("account_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "origination"."documentary_screening_evidence"
ADD CONSTRAINT "documentary_screening_evidence_review_consistency_check"
CHECK (
  ("status" = 'pending' AND "reviewed_by_account_id" IS NULL AND "reviewed_at" IS NULL) OR
  ("status" IN ('mandatory_missing', 'accepted', 'rejected') AND
   "reviewed_by_account_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
);

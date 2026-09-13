-- Staff can now create-and-submit an origination case on an applicant's
-- behalf in one action (phone/in-person intake). Its revision needs its own
-- reason distinct from "initial" so provenance survives independently of
-- the audit log.
ALTER TABLE "origination"."submission_revisions"
DROP CONSTRAINT "submission_revisions_reason_check";

ALTER TABLE "origination"."submission_revisions"
ADD CONSTRAINT "submission_revisions_reason_check"
CHECK ("reason" IN ('initial', 'resubmission_after_rfi', 'initial_staff_created'));

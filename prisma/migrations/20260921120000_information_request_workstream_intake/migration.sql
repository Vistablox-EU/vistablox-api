ALTER TABLE "intake"."information_requests"
DROP CONSTRAINT "information_requests_workstream_check";

ALTER TABLE "intake"."information_requests"
ADD CONSTRAINT "information_requests_workstream_check"
CHECK ("requesting_workstream" IN ('legal', 'appraisal', 'origination', 'intake'));
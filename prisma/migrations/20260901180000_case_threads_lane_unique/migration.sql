-- REAL_ESTATE_INTAKE_LIFECYCLE.md's Thread Rules: "every case gets the same
-- fixed lane set" -- exactly one thread per (case, lane), not an unbounded
-- set. The table existed since the initial schema with no application code
-- ever writing to it, so this is safe to add now, before any row exists.
ALTER TABLE "origination"."case_threads"
  ADD CONSTRAINT "case_threads_case_id_lane_key" UNIQUE ("case_id", "lane");

ALTER TABLE "intake"."intake_cases"
  ADD COLUMN "workflow_event_sequence" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "intake"."intake_case_events" (
  "event_id" TEXT NOT NULL,
  "case_id" TEXT NOT NULL,
  "event_sequence" INTEGER NOT NULL,
  "event_key" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "workflow_type" TEXT NOT NULL,
  "workflow_version" INTEGER NOT NULL,
  "from_stage" TEXT,
  "to_stage" TEXT,
  "actor_type" TEXT NOT NULL,
  "actor_account_id" TEXT,
  "trace_id" TEXT,
  "causation_event_id" TEXT,
  "related_resource_type" TEXT,
  "related_resource_id" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "event_source" TEXT NOT NULL DEFAULT 'live',
  "source_audit_log_id" TEXT,
  "source_job_id" TEXT,
  CONSTRAINT "intake_case_events_pkey" PRIMARY KEY ("event_id"),
  CONSTRAINT "intake_case_events_event_sequence_check" CHECK ("event_sequence" > 0),
  CONSTRAINT "intake_case_events_workflow_version_check" CHECK ("workflow_version" >= 0),
  CONSTRAINT "intake_case_events_stage_check" CHECK (
    ("from_stage" IS NULL OR "from_stage" IN ('draft', 'submitted', 'waiting_on_applicant', 'pre_offering_open', 'post_ipo_structuring', 'approved_for_final_offering', 'rejected', 'withdrawn', 'expired'))
    AND ("to_stage" IS NULL OR "to_stage" IN ('draft', 'submitted', 'waiting_on_applicant', 'pre_offering_open', 'post_ipo_structuring', 'approved_for_final_offering', 'rejected', 'withdrawn', 'expired'))
  ),
  CONSTRAINT "intake_case_events_actor_type_check" CHECK ("actor_type" IN ('staff', 'applicant', 'partner', 'system')),
  CONSTRAINT "intake_case_events_system_actor_check" CHECK ("actor_type" <> 'system' OR "actor_account_id" IS NULL),
  CONSTRAINT "intake_case_events_event_source_check" CHECK ("event_source" IN ('live', 'legacy_audit')),
  CONSTRAINT "intake_case_events_transition_check" CHECK (("from_stage" IS NULL AND "to_stage" IS NULL) OR ("from_stage" IS NOT NULL AND "to_stage" IS NOT NULL AND "from_stage" <> "to_stage")),
  CONSTRAINT "intake_case_events_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "intake"."intake_cases"("case_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "intake_case_events_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "intake_case_events_event_key_key" ON "intake"."intake_case_events"("event_key");
CREATE UNIQUE INDEX "intake_case_events_source_audit_log_id_key" ON "intake"."intake_case_events"("source_audit_log_id");
CREATE UNIQUE INDEX "intake_case_events_case_id_event_sequence_key" ON "intake"."intake_case_events"("case_id", "event_sequence");
CREATE INDEX "intake_case_events_case_id_event_sequence_idx" ON "intake"."intake_case_events"("case_id", "event_sequence" DESC);
CREATE INDEX "intake_case_events_case_id_occurred_at_event_id_idx" ON "intake"."intake_case_events"("case_id", "occurred_at" DESC, "event_id" DESC);
CREATE INDEX "intake_case_events_event_type_occurred_at_idx" ON "intake"."intake_case_events"("event_type", "occurred_at" DESC);
CREATE INDEX "intake_case_events_related_resource_idx" ON "intake"."intake_case_events"("related_resource_type", "related_resource_id", "occurred_at" DESC);

CREATE OR REPLACE FUNCTION "intake"."reject_intake_case_event_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'intake case events are append-only';
END;
$$;

CREATE TRIGGER "intake_case_events_append_only"
BEFORE UPDATE OR DELETE ON "intake"."intake_case_events"
FOR EACH ROW EXECUTE FUNCTION "intake"."reject_intake_case_event_mutation"();

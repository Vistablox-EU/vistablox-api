ALTER TABLE "intake"."intake_case_events"
  ADD COLUMN "reversal_of_event_id" TEXT;

CREATE UNIQUE INDEX "intake_case_events_reversal_of_event_id_key"
  ON "intake"."intake_case_events"("reversal_of_event_id");

ALTER TABLE "intake"."intake_case_events"
  ADD CONSTRAINT "intake_case_events_reversal_of_event_id_fkey"
  FOREIGN KEY ("reversal_of_event_id") REFERENCES "intake"."intake_case_events"("event_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "intake"."validate_intake_case_reversal_event"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reversal_of_event_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "intake"."intake_case_events" e WHERE e.event_id = NEW.reversal_of_event_id AND e.reversal_of_event_id IS NOT NULL) THEN
      RAISE EXCEPTION 'a reversal event cannot reverse another reversal';
    END IF;
    IF NEW.from_stage IS NULL OR NEW.to_stage IS NULL OR NEW.from_stage = NEW.to_stage THEN
      RAISE EXCEPTION 'reversal events require a stage transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "intake_case_events_reversal_validation"
BEFORE INSERT ON "intake"."intake_case_events"
FOR EACH ROW EXECUTE FUNCTION "intake"."validate_intake_case_reversal_event"();

CREATE TABLE "intake"."intake_case_reversal_operations" (
  "operation_id" TEXT NOT NULL,
  "case_id" TEXT NOT NULL,
  "command" TEXT NOT NULL,
  "from_stage" TEXT NOT NULL,
  "to_stage" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "requested_by_account_id" TEXT NOT NULL,
  "approved_by_account_id" TEXT,
  "expected_stage" TEXT NOT NULL,
  "expected_workflow_event_sequence" INTEGER NOT NULL,
  "reversal_of_event_id" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "trace_id" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "failure_code" TEXT,
  "failure_detail" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "failed_at" TIMESTAMPTZ(6),
  CONSTRAINT "intake_case_reversal_operations_pkey" PRIMARY KEY ("operation_id"),
  CONSTRAINT "intake_case_reversal_operations_reason_check" CHECK (char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "intake_case_reversal_operations_status_check" CHECK ("status" IN ('requested', 'pending_approval', 'approved', 'executing', 'completed', 'failed', 'cancelled')),
  CONSTRAINT "intake_case_reversal_operations_stage_check" CHECK (
    "from_stage" IN ('draft', 'submitted', 'waiting_on_applicant', 'pre_offering_open', 'post_ipo_structuring', 'approved_for_final_offering', 'rejected', 'withdrawn', 'expired')
    AND "to_stage" IN ('draft', 'submitted', 'waiting_on_applicant', 'pre_offering_open', 'post_ipo_structuring', 'approved_for_final_offering', 'rejected', 'withdrawn', 'expired')
  ),
  CONSTRAINT "intake_case_reversal_operations_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "intake"."intake_cases"("case_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "intake_case_reversal_operations_requested_by_fkey" FOREIGN KEY ("requested_by_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "intake_case_reversal_operations_approved_by_fkey" FOREIGN KEY ("approved_by_account_id") REFERENCES "account"."accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "intake_case_reversal_operations_reversal_event_fkey" FOREIGN KEY ("reversal_of_event_id") REFERENCES "intake"."intake_case_events"("event_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "intake_case_reversal_operations_case_id_idempotency_key_key"
  ON "intake"."intake_case_reversal_operations"("case_id", "idempotency_key");
CREATE INDEX "intake_case_reversal_operations_case_id_created_at_idx"
  ON "intake"."intake_case_reversal_operations"("case_id", "created_at" DESC);
CREATE INDEX "intake_case_reversal_operations_status_created_at_idx"
  ON "intake"."intake_case_reversal_operations"("status", "created_at" DESC);

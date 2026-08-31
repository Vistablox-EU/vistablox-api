ALTER TABLE "audit"."audit_log"
  ADD COLUMN "event_key" TEXT;

CREATE UNIQUE INDEX "audit_log_event_key_key"
  ON "audit"."audit_log"("event_key");

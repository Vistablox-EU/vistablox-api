ALTER TABLE "platform"."stored_documents"
  ADD COLUMN "deleted_at" TIMESTAMPTZ(6),
  ADD COLUMN "deleted_by_account_id" TEXT,
  ADD COLUMN "deletion_reason" TEXT,
  ADD COLUMN "source_document_id" TEXT,
  ADD COLUMN "variant_type" TEXT;

ALTER TABLE "platform"."stored_documents"
  ADD CONSTRAINT "stored_documents_source_document_id_fkey"
  FOREIGN KEY ("source_document_id") REFERENCES "platform"."stored_documents"("document_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "stored_documents_source_variant_key"
  ON "platform"."stored_documents"("source_document_id", "variant_type");

DROP INDEX IF EXISTS "platform"."idx_stored_documents_room_status_created";
CREATE INDEX "idx_stored_documents_room_status_created"
  ON "platform"."stored_documents"("room_id", "upload_status", "deleted_at", "created_at");

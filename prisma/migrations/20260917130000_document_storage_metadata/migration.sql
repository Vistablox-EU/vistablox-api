CREATE TABLE "platform"."stored_documents" (
    "document_id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "version_id" TEXT,
    "document_type" TEXT NOT NULL,
    "case_id" TEXT,
    "account_id" TEXT,
    "offering_id" TEXT,
    "content_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256_checksum" TEXT NOT NULL,
    "upload_status" TEXT NOT NULL DEFAULT 'quarantined',
    "classification" TEXT NOT NULL DEFAULT 'private',
    "retention_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stored_documents_pkey" PRIMARY KEY ("document_id")
);
CREATE UNIQUE INDEX "stored_documents_bucket_object_key_version_id_key"
  ON "platform"."stored_documents"("bucket", "object_key", "version_id");
CREATE INDEX "idx_stored_documents_case" ON "platform"."stored_documents"("case_id");
CREATE INDEX "idx_stored_documents_account" ON "platform"."stored_documents"("account_id");
CREATE INDEX "idx_stored_documents_offering" ON "platform"."stored_documents"("offering_id");

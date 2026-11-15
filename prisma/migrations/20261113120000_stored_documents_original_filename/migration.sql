-- Staff upload disclosure documents through the API
-- (POST /internal/v1/offerings/:offering_id/documents) and the admin lists
-- them by the name the file had on upload. Object keys are server-generated
-- and must never carry the original name (docs/document-storage.md), and
-- S3 user metadata is ASCII-only, so the name lives on the metadata row.
-- Nullable: intake's case-document rows predate it and never recorded one.
ALTER TABLE "platform"."stored_documents" ADD COLUMN "original_filename" TEXT;

ALTER TABLE "platform"."stored_documents"
  ADD COLUMN "room_id" TEXT;

ALTER TABLE "intake"."property_rooms"
  ADD COLUMN "preferred_photo_id" TEXT;

ALTER TABLE "platform"."stored_documents"
  ADD CONSTRAINT "stored_documents_room_id_fkey"
  FOREIGN KEY ("room_id") REFERENCES "intake"."property_rooms"("room_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "idx_stored_documents_room_status_created"
  ON "platform"."stored_documents"("room_id", "upload_status", "created_at");

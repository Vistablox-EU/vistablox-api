-- Issue #179: a reset-triggering materiality record names the disclosure-pack
-- version reconfirmation must wait for, and a reconfirmed reservation records
-- the pack it was reconfirmed against.
ALTER TABLE "offering"."materiality_records"
ADD COLUMN "required_disclosure_pack_version" INTEGER;

-- Backfill: a reset already on record requires a pack newer than whatever was
-- published at or before its classification instant.
UPDATE "offering"."materiality_records" AS record
SET "required_disclosure_pack_version" = COALESCE((
  SELECT MAX(pack."version")
  FROM "offering"."disclosure_packs" AS pack
  WHERE pack."offering_id" = record."offering_id"
    AND pack."published_at" <= record."classified_at"
), 0) + 1
WHERE record."reset_triggered";

ALTER TABLE "offering"."materiality_records"
ADD CONSTRAINT "materiality_records_required_pack_version_check"
CHECK (
  ("reset_triggered" AND "required_disclosure_pack_version" IS NOT NULL)
  OR (NOT "reset_triggered" AND "required_disclosure_pack_version" IS NULL)
);

ALTER TABLE "offering"."reservations"
ADD COLUMN "reconfirmed_disclosure_pack_id" TEXT;

ALTER TABLE "offering"."reservations"
ADD CONSTRAINT "reservations_reconfirmed_disclosure_pack_id_fkey"
FOREIGN KEY ("reconfirmed_disclosure_pack_id")
REFERENCES "offering"."disclosure_packs"("disclosure_pack_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

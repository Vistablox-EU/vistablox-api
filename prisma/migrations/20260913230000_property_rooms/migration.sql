-- Per-room breakdown for a property (each room individually, with its own
-- type and size), additive alongside the bedrooms/bathrooms aggregate
-- counts #95 shipped -- not a replacement. Modeled on
-- documentary_screening_evidence's shape: own id, FK, index, no
-- update/delete (rooms are set once at property creation, same as every
-- other property field).
CREATE TABLE "origination"."property_rooms" (
    "room_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "room_type" TEXT NOT NULL,
    "size_sq_m" DECIMAL(6,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_rooms_pkey" PRIMARY KEY ("room_id")
);

CREATE INDEX "idx_property_rooms_property" ON "origination"."property_rooms"("property_id");

ALTER TABLE "origination"."property_rooms"
  ADD CONSTRAINT "property_rooms_property_id_fkey"
  FOREIGN KEY ("property_id") REFERENCES "origination"."properties"("property_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "origination"."property_rooms"
ADD CONSTRAINT "property_rooms_room_type_check"
CHECK ("room_type" IN ('bedroom', 'bathroom', 'kitchen', 'living_room', 'dining_room', 'office', 'storage', 'other'));

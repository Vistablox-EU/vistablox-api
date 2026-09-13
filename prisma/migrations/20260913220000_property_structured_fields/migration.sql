-- Structured residential detail on properties, all nullable/omittable --
-- property_type itself stays locked to 'residential' by AD-081
-- (properties_residential_only, unchanged here); residential_subtype is a
-- separate new column, not a change to that constraint.
ALTER TABLE "origination"."properties"
  ADD COLUMN "residential_subtype" TEXT,
  ADD COLUMN "living_area_sq_m" DECIMAL(6,2),
  ADD COLUMN "bedrooms" INTEGER,
  ADD COLUMN "bathrooms" INTEGER,
  ADD COLUMN "floor" INTEGER,
  ADD COLUMN "total_floors" INTEGER,
  ADD COLUMN "year_built" INTEGER,
  ADD COLUMN "condition" TEXT,
  ADD COLUMN "energy_rating" TEXT;

ALTER TABLE "origination"."properties"
ADD CONSTRAINT "properties_residential_subtype_check"
CHECK (
  "residential_subtype" IS NULL OR
  "residential_subtype" IN ('apartment', 'house', 'townhouse', 'multi_family', 'studio', 'other')
);

ALTER TABLE "origination"."properties"
ADD CONSTRAINT "properties_condition_check"
CHECK (
  "condition" IS NULL OR
  "condition" IN ('new', 'renovated', 'good', 'fair', 'needs_renovation')
);

-- Standard EU EPC scale.
ALTER TABLE "origination"."properties"
ADD CONSTRAINT "properties_energy_rating_check"
CHECK (
  "energy_rating" IS NULL OR
  "energy_rating" IN ('A+', 'A', 'B', 'C', 'D', 'E', 'F', 'G')
);

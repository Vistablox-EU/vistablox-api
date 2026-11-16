ALTER TABLE "offering"."offerings"
ADD COLUMN "hero_image_url" TEXT,
ADD COLUMN "gallery_image_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Rename the property-case domain schema and its primary case table.
-- Historical migration files retain their original names and SQL so Prisma
-- checksums remain valid; this forward migration updates existing databases.
ALTER SCHEMA "origination" RENAME TO "intake";

ALTER TABLE "intake"."origination_cases" RENAME TO "intake_cases";

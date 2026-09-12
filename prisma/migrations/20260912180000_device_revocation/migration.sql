-- Device revocation, first used by customer account-recovery completion: a
-- recovered customer's devices are revoked (status 'revoked', with when and
-- why) rather than deleted, so the audit trail keeps pointing at real rows.
ALTER TABLE "auth"."devices"
  ADD COLUMN "revoked_at" TIMESTAMPTZ(6),
  ADD COLUMN "revocation_reason" TEXT;

-- A revoked device's DPoP key must be free to enrol again: after recovery the
-- customer sets the same phone up again, and the app keeps its DPoP key. The
-- key is therefore unique among ACTIVE devices only, the same shape as
-- devices_one_active_per_account. Like that index, this partial unique index
-- isn't modeled in schema.prisma (Prisma's DSL has no syntax for one);
-- PrismaDeviceRepository.create maps its P2002 by name.
ALTER TABLE "auth"."devices" DROP CONSTRAINT "devices_dpop_jkt_key";

CREATE UNIQUE INDEX "devices_dpop_jkt_active_key"
  ON "auth"."devices" ("dpop_jkt")
  WHERE "status" = 'active';

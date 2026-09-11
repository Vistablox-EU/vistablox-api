-- The "account already has an active device" check in EnrolDeviceService
-- (findActiveDeviceForAccount, then later devices.create) is check-then-insert
-- and therefore racy: two concurrent enrolment requests for the same
-- account can both pass the check before either has inserted. A partial
-- unique index makes the second insert fail at the database instead,
-- closing the race outright. Prisma's schema DSL has no syntax for a
-- partial unique index, so this deliberately isn't modeled in
-- schema.prisma (same reasoning as the hand-written migration.sql for the
-- rest of this table) -- PrismaDeviceRepository.create() catches the
-- resulting P2002 by this constraint's name and maps it to
-- DevicePairingNotImplementedError, same as the non-raced path.
CREATE UNIQUE INDEX "devices_one_active_per_account"
  ON "auth"."devices" ("account_id")
  WHERE "status" = 'active';

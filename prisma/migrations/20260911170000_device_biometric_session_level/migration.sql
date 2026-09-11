-- #54 introduced authenticationLevel = 'device_biometric' (E2/L2 session
-- creation) in code, but no migration ever widened this constraint to
-- allow it -- every real E2/L2 session creation failed with a check
-- constraint violation (confirmed live: the Xiaomi enrolment test reached
-- attestation/JWS/challenge/DPoP success and crashed here,
-- internalAdapter.createSession -> 500). auth_session itself is
-- unqualified/public schema, matching every other reference to it (see
-- 20260910140000_dpop_device_binding's own comment on this).
ALTER TABLE "auth_session" DROP CONSTRAINT "auth_session_authentication_level_check";

ALTER TABLE "auth_session"
  ADD CONSTRAINT "auth_session_authentication_level_check"
  CHECK ("authenticationLevel" IN ('unassured', 'oauth_pending', 'oauth_passkey', 'staff_passkey', 'device_biometric'));

-- Orphan cleanup: because the constraint above rejected every session with
-- authenticationLevel = 'device_biometric', no enrolment could ever
-- complete before this migration -- EnrolDeviceService.execute() (which
-- creates the auth.devices row) always ran to completion before the
-- createSession call that then failed, with no transaction wrapping the
-- two. Every existing auth.devices row is therefore an orphan: enrolled
-- but never actually usable, and blocking a retry outright via the
-- one-active-device-per-account partial unique index (409
-- DEVICE_ALREADY_ENROLLED). There is no production environment yet, and
-- staging has exactly one such row (the Xiaomi test device). Safe to
-- delete unconditionally rather than a narrower "no matching
-- device_biometric session" predicate, which is equivalent here since
-- there are zero device_biometric sessions in existence by construction.
DELETE FROM "auth"."devices";

-- Device-bound auth, Phase 4 (direct cutover): customer recovery codes and
-- TOTP backup codes are removed. A code written down is a shared secret with
-- no device binding (docs/plans/device-bound-auth-backend.md, findings 5a and
-- 5b). DESTRUCTIVE: both tables and every row in them are dropped. Staging
-- holds only test data, and there is no production database yet.
--
-- Dropping each table also drops its indexes and its foreign key to
-- account.accounts:
--   auth.mfa_backup_codes: mfa_backup_codes_pkey,
--     mfa_backup_codes_account_code_key, idx_mfa_backup_codes_account,
--     mfa_backup_codes_account_id_fkey
--   auth.account_recovery_codes: account_recovery_codes_pkey,
--     account_recovery_codes_account_id_fkey
-- auth.mfa_totp_factors (the TOTP secrets themselves) is untouched.
DROP TABLE "auth"."mfa_backup_codes";
DROP TABLE "auth"."account_recovery_codes";

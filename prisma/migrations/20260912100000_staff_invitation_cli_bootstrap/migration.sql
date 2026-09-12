-- One-time first-admin bootstrap (npm run staff:bootstrap-first-admin).
--
-- Every staff invitation so far is issued by a signed-in admin_operations
-- account, so invited_by_account_id was NOT NULL. The very first admin has no
-- such issuer. Rather than inventing a fake "system" account, the column
-- becomes nullable and a marker says how the row was issued; the CHECK below
-- allows a null issuer only on bootstrap rows, and only for admin_operations.
--
-- Non-destructive: existing rows keep their issuer and get issued_via =
-- 'staff' from the default, which satisfies the new CHECK.

ALTER TABLE "auth"."staff_invitations"
  ADD COLUMN "issued_via" TEXT NOT NULL DEFAULT 'staff';

ALTER TABLE "auth"."staff_invitations"
  ALTER COLUMN "invited_by_account_id" DROP NOT NULL;

ALTER TABLE "auth"."staff_invitations"
  ADD CONSTRAINT "staff_invitations_issued_via_check" CHECK (
    ("issued_via" = 'staff' AND "invited_by_account_id" IS NOT NULL) OR
    ("issued_via" = 'cli_bootstrap' AND "invited_by_account_id" IS NULL AND "role" = 'admin_operations')
  );

-- At most one live bootstrap invitation at a time. The CLI already serializes
-- on an advisory lock and revokes the previous one before issuing; this is the
-- database-level backstop.
CREATE UNIQUE INDEX "staff_invitations_one_pending_bootstrap_key"
  ON "auth"."staff_invitations"("issued_via")
  WHERE "issued_via" = 'cli_bootstrap' AND "accepted_at" IS NULL AND "revoked_at" IS NULL;

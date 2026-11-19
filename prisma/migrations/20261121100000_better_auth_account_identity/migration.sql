-- Better Auth 1.7.3 and later identify an account by (providerId, accountId)
-- again, as 1.6 did, and no longer write auth_account.issuer. The 1.7.0 to
-- 1.7.2 releases required that column and the unique index on
-- (issuer, accountId); this database was created with both
-- (20260831154500_better_auth_core). With the NOT NULL still in place, every
-- insert into auth_account (a first Google or Apple sign-in, an account link)
-- fails once better-auth 1.7.7 runs.
--
-- Steps follow Better Auth's 1.7 upgrade guide for Postgres, plus one:
--   1. issuer becomes nullable. Existing rows keep their value; the column
--      is not dropped, so this can be undone and nothing is lost.
--   2. The (issuer, accountId) unique index goes (the index is dropped before
--      anything else touches the column).
--   3. A unique index on (providerId, accountId) replaces it, so the database
--      still refuses a second row for one provider identity. The guide only
--      drops the old index; keeping a guard is this repository's choice.
--
-- Compatible with both versions: better-auth 1.7.2 still writes issuer, which
-- the nullable column accepts, so this can be applied before the new code
-- runs (the staging compose file runs migrate to completion before api and
-- worker start).
--
-- Step 3 fails, and the whole migration with it, if two rows already share a
-- (providerId, accountId). Better Auth refuses to look up an account when more
-- than one row matches, so such rows need fixing by hand either way. Check
-- before deploying:
--   SELECT "providerId", "accountId", count(*) FROM "auth_account"
--   GROUP BY 1, 2 HAVING count(*) > 1;
ALTER TABLE "auth_account" ALTER COLUMN "issuer" DROP NOT NULL;

DROP INDEX "auth_account_issuer_accountId_uidx";

CREATE UNIQUE INDEX "auth_account_providerId_accountId_uidx"
  ON "auth_account"("providerId", "accountId");

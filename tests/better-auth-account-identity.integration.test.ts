import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createBetterAuth } from "../src/modules/auth/infrastructure/shared/better-auth.factory.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// Better Auth 1.7.3 and later identify an account by (providerId, accountId)
// and no longer write auth_account.issuer, which 1.7.0 to 1.7.2 required.
// 20260831154500_better_auth_core created that column as NOT NULL with a
// unique index on (issuer, accountId);
// 20261121100000_better_auth_account_identity relaxes the column and puts the
// unique guard on (providerId, accountId). Without it every insert into
// auth_account fails, and Better Auth's own schema check refuses requests.
describe.skipIf(databaseUrl === undefined)("auth_account identity PostgreSQL integration", () => {
  const suffix = randomUUID();
  const pool = new Pool({ connectionString: databaseUrl });
  const auth = createBetterAuth({
    database: pool,
    baseURL: "http://localhost:3000",
    secret: "integration-test-secret-that-is-at-least-32-characters",
    secureCookies: false,
    trustedOrigins: ["http://localhost:3000"],
    allowPopulationInput: true,
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createCustomer(label: string) {
    const context = await auth.$context;
    return context.internalAdapter.createUser(
      {
        name: `Account identity ${label}`,
        email: `account-identity-${label}-${suffix}@example.test`,
        emailVerified: true,
        population: "customer",
      },
      { method: "internal" },
    );
  }

  it("passes Better Auth's own schema check against the migrated database", async () => {
    const context = await auth.$context;

    // A missing check would let this pass without checking anything.
    expect(context.checkSchema).toBeTypeOf("function");
    await expect(context.checkSchema?.()).resolves.toBeUndefined();
  });

  it("links an account without an issuer, which is how Better Auth writes it now", async () => {
    const context = await auth.$context;
    const user = await createCustomer("link");
    const accountId = `google-link-${suffix}`;

    const account = await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "google",
      accountId,
    });

    expect(account).toMatchObject({ providerId: "google", accountId, userId: user.id });
    const stored = await pool.query<{ issuer: string | null }>(
      `SELECT "issuer" FROM "auth_account" WHERE "id" = $1`,
      [account.id],
    );
    expect(stored.rows).toEqual([{ issuer: null }]);
  });

  it("refuses a second row for one provider identity but allows the account id under another provider", async () => {
    const first = await createCustomer("unique-first");
    const second = await createCustomer("unique-second");
    const accountId = `shared-subject-${suffix}`;
    const insert = (id: string, providerId: string, userId: string) =>
      pool.query(
        `INSERT INTO "auth_account" ("id", "accountId", "providerId", "userId", "updatedAt")
         VALUES ($1, $2, $3, $4, now())`,
        [id, accountId, providerId, userId],
      );

    await insert(`acct-google-${suffix}`, "google", first.id);

    await expect(insert(`acct-google-again-${suffix}`, "google", second.id)).rejects.toThrow(
      /auth_account_providerId_accountId_uidx/,
    );
    await expect(insert(`acct-apple-${suffix}`, "apple", second.id)).resolves.toBeDefined();
  });

  it("has dropped the (issuer, accountId) unique index that 1.7.0 to 1.7.2 needed", async () => {
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT "indexname" FROM "pg_indexes" WHERE "schemaname" = 'public' AND "tablename" = 'auth_account'`,
    );
    const names = indexes.rows.map((row) => row.indexname);

    expect(names).toContain("auth_account_providerId_accountId_uidx");
    expect(names).not.toContain("auth_account_issuer_accountId_uidx");
  });
});

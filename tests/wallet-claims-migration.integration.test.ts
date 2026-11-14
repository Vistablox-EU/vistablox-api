import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 20261113150200_wallet_claims_confirmed_address_uniqueness. The migration's
// guard and its CREATE UNIQUE INDEX are run here against a TEMPORARY copy of
// wallet_registrations inside a transaction that is always rolled back, so the
// shared table and the index the other integration suites rely on are never
// touched. (The DROP INDEX is deliberately not run: the index it drops is
// already gone in this database.)
const databaseUrl = process.env.TEST_DATABASE_URL;

const migrationSql = readFileSync(
  resolve(
    import.meta.dirname,
    "../prisma/migrations/20261113150200_wallet_claims_confirmed_address_uniqueness/migration.sql",
  ),
  "utf8",
);

function statement(pattern: RegExp): string {
  const match = migrationSql.match(pattern);
  if (match === null) throw new Error(`migration.sql no longer matches ${pattern}`);
  return match[0].replaceAll('"settlement"."wallet_registrations"', "wr").replaceAll("settlement.wallet_registrations", "wr");
}

describe.skipIf(databaseUrl === undefined)("wallet claims migration PostgreSQL integration", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient;
  const suffix = randomUUID().replaceAll("-", "");
  const address = `0x${suffix}00000000`;

  const guard = () => statement(/DO \$\$[\s\S]*?\n\$\$;/);
  const createIndex = () => statement(/CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*?;/);

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  // Runs `body` inside a transaction that is always rolled back, against a
  // fresh temporary table shaped like wallet_registrations (columns, NOT NULLs
  // and defaults; no indexes, no foreign key).
  async function withTemporaryTable(body: () => Promise<void>): Promise<void> {
    await client.query("BEGIN");
    try {
      await client.query("CREATE TEMP TABLE wr (LIKE settlement.wallet_registrations INCLUDING DEFAULTS) ON COMMIT DROP");
      await body();
    } finally {
      await client.query("ROLLBACK");
    }
  }

  const insertRow = (accountId: string, walletAddress: string, confirmed: boolean) =>
    client.query(
      "INSERT INTO wr (account_id, wallet_address, registration_commitment, registered_at) VALUES ($1, $2, $3, $4)",
      [accountId, walletAddress, `commitment_${accountId}`, confirmed ? new Date("2026-11-01T00:00:00Z") : null],
    );

  it("ships the guard, the drop and the partial unique index in one file", () => {
    expect(migrationSql).toMatch(/DROP INDEX IF EXISTS "settlement"\."wallet_registrations_wallet_address_key"/);
    expect(createIndex()).toMatch(/\(lower\("wallet_address"\)\)\s+WHERE "registered_at" IS NOT NULL/);
    expect(migrationSql).toMatch(/find-violators query/i);
  });

  it("stops with unique_violation and counts only, naming no address or account, when two confirmed rows share an address", async () => {
    await withTemporaryTable(async () => {
      await insertRow("acct_migration_a", `0xAbC${address.slice(5)}`, true);
      await insertRow("acct_migration_b", `0xaBc${address.slice(5)}`, true);
      await insertRow("acct_migration_c", `0xabc${address.slice(5)}`, false);

      const failure = await client.query(guard()).then(
        () => null,
        (error: { code?: string; message: string; detail?: string; hint?: string }) => error,
      );

      expect(failure).not.toBeNull();
      expect(failure!.code).toBe("23505");
      expect(failure!.message).toMatch(/1 address\(es\) are held by more than one confirmed registration \(2 rows\)/);
      const everything = `${failure!.message} ${failure!.detail ?? ""} ${failure!.hint ?? ""}`;
      expect(everything).not.toContain(address.slice(5));
      expect(everything).not.toContain("acct_migration");
    });
  });

  it("passes when one confirmed row has any number of pending case variants, and the index is then enforced", async () => {
    await withTemporaryTable(async () => {
      await insertRow("acct_migration_a", `0xAbC${address.slice(5)}`, true);
      await insertRow("acct_migration_b", `0xaBc${address.slice(5)}`, false);
      await insertRow("acct_migration_c", `0xabc${address.slice(5)}`, false);

      await client.query(guard());
      await client.query(createIndex());
      // Re-running the index statement is a no-op, as the file promises.
      await client.query(createIndex());

      await client.query("SAVEPOINT second_confirmed");
      await expect(
        client.query("UPDATE wr SET registered_at = now() WHERE account_id = 'acct_migration_b'"),
      ).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT second_confirmed");

      // A third, unrelated address confirms fine.
      await insertRow("acct_migration_d", `0xdef${address.slice(5)}`, true);
    });
  });

  it("passes on an empty table", async () => {
    await withTemporaryTable(async () => {
      await client.query(guard());
    });
  });
});

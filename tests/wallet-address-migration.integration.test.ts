import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 20261113150100_wallet_address_canonical_form lower-cases the stored wallet
// addresses and adds the lowercase CHECK, and refuses (changing nothing) when
// two accounts hold one address in different case.
//
// The migration is executed here against a scratch copy of the table, inside
// a transaction that is rolled back, for two reasons: it takes an ACCESS
// EXCLUSIVE lock on the table it names, which would stall every other test
// file that touches settlement.wallet_registrations, and the refusal case
// needs rows that the real table's own CHECK and unique index would not
// allow. The copy is made WITHOUT the lowercase check (the test database has
// already had the migration applied), and the real table's name in the SQL is
// replaced by the copy's. A SAVEPOINT around each attempted migration lets one
// transaction observe a refusal and still read the rows afterwards, the same
// way money-ledger-integrity.integration.test.ts does it.

const migrationPath = fileURLToPath(
  new URL("../prisma/migrations/20261113150100_wallet_address_canonical_form/migration.sql", import.meta.url),
);
const REAL_TABLE = '"settlement"."wallet_registrations"';
const CHECK_NAME = "wallet_registrations_wallet_address_lowercase_check";

describe.skipIf(databaseUrl === undefined)("wallet address canonical form migration (PostgreSQL integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const migration = readFileSync(migrationPath, "utf8");

  afterAll(async () => {
    await pool.end();
  });

  it("names the real table only in the form this test replaces", () => {
    const statements = migration
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).toContain(REAL_TABLE);
    expect(statements.split(REAL_TABLE).join("")).not.toMatch(/settlement/i);
  });

  interface Scratch {
    client: PoolClient;
    table: string;
    schema: string;
    notices: string[];
  }

  // One rolled-back transaction per case, with its own scratch schema.
  async function withScratchTable(body: (scratch: Scratch) => Promise<void>): Promise<void> {
    const client = await pool.connect();
    const schema = `wallet_mig_${randomUUID().replace(/-/g, "")}`;
    const notices: string[] = [];
    client.on("notice", (notice) => notices.push(notice.message ?? ""));
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(
        `CREATE TABLE "${schema}"."wallet_registrations" (LIKE "settlement"."wallet_registrations" INCLUDING ALL)`,
      );
      // The copy starts in the state before the migration.
      await client.query(`ALTER TABLE "${schema}"."wallet_registrations" DROP CONSTRAINT IF EXISTS "${CHECK_NAME}"`);
      await body({ client, table: `"${schema}"."wallet_registrations"`, schema, notices });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  const runMigration = (scratch: Scratch) => scratch.client.query(migration.split(REAL_TABLE).join(scratch.table));

  const insertRow = (
    scratch: Scratch,
    accountId: string,
    address: string,
    options: { registered?: boolean } = {},
  ) =>
    scratch.client.query(
      `INSERT INTO ${scratch.table} (account_id, wallet_address, registration_commitment, registered_at)
       VALUES ($1, $2, $3, ${options.registered === true ? "now()" : "NULL"})`,
      [accountId, address, `commitment_${accountId}`],
    );

  const addresses = async (scratch: Scratch) =>
    Object.fromEntries(
      (
        await scratch.client.query<{ account_id: string; wallet_address: string }>(
          `SELECT account_id, wallet_address FROM ${scratch.table} ORDER BY account_id`,
        )
      ).rows.map((row) => [row.account_id, row.wallet_address]),
    );

  const xmins = async (scratch: Scratch) =>
    Object.fromEntries(
      (
        await scratch.client.query<{ account_id: string; xmin: string }>(
          `SELECT account_id, xmin::text AS xmin FROM ${scratch.table} ORDER BY account_id`,
        )
      ).rows.map((row) => [row.account_id, row.xmin]),
    );

  const checkExists = async (scratch: Scratch) =>
    (
      await scratch.client.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`,
        [CHECK_NAME, scratch.table],
      )
    ).rowCount === 1;

  const upper = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const mixed = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
  const lowerAlready = "0x1111111111111111111111111111111111111111";

  it("lower-cases mixed-case rows, leaves the others untouched, and adds the check", async () => {
    await withScratchTable(async (scratch) => {
      await insertRow(scratch, "acct_a", mixed);
      await insertRow(scratch, "acct_b", lowerAlready);
      await insertRow(scratch, "acct_c", upper);
      const before = await xmins(scratch);

      await runMigration(scratch);

      expect(await addresses(scratch)).toEqual({
        acct_a: mixed.toLowerCase(),
        acct_b: lowerAlready,
        acct_c: upper.toLowerCase(),
      });
      const after = await xmins(scratch);
      expect(after.acct_b).toBe(before.acct_b);
      expect(after.acct_a).not.toBe(before.acct_a);
      expect(scratch.notices).toContain("wallet_registrations: 2 wallet address(es) rewritten to lower case");
      expect(await checkExists(scratch)).toBe(true);
    });
  });

  it("is a no-op the second time it is executed", async () => {
    await withScratchTable(async (scratch) => {
      await insertRow(scratch, "acct_a", mixed);
      await insertRow(scratch, "acct_b", lowerAlready);
      await runMigration(scratch);
      const afterFirst = await xmins(scratch);
      scratch.notices.length = 0;

      await runMigration(scratch);

      expect(await xmins(scratch)).toEqual(afterFirst);
      expect(await addresses(scratch)).toEqual({ acct_a: mixed.toLowerCase(), acct_b: lowerAlready });
      expect(scratch.notices).toContain("wallet_registrations: 0 wallet address(es) rewritten to lower case");
      const constraints = await scratch.client.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`,
        [CHECK_NAME, scratch.table],
      );
      expect(constraints.rowCount).toBe(1);
    });
  });

  it("works on an empty table", async () => {
    await withScratchTable(async (scratch) => {
      await runMigration(scratch);
      expect(await checkExists(scratch)).toBe(true);
    });
  });

  it("refuses a case collision, names it without account ids, and changes nothing", async () => {
    await withScratchTable(async (scratch) => {
      const collidingUpper = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
      const collidingMixed = "0xbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBB";
      await insertRow(scratch, "acct_secret_confirmed", collidingUpper, { registered: true });
      await insertRow(scratch, "acct_secret_pending", collidingMixed);
      // Would have been rewritten if the migration were not all-or-nothing.
      await insertRow(scratch, "acct_secret_bystander", mixed);
      const before = await addresses(scratch);
      const xminsBefore = await xmins(scratch);

      await scratch.client.query("SAVEPOINT attempt");
      const error: unknown = await runMigration(scratch).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      await scratch.client.query("ROLLBACK TO SAVEPOINT attempt");

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("lower-casing would collide on 1 address(es)");
      expect(message).toContain(`${collidingUpper.toLowerCase()} (2 claims, 1 registered)`);
      expect(message).toContain("Nothing was changed");
      expect(message).not.toContain("acct_secret");
      expect(await addresses(scratch)).toEqual(before);
      expect(await xmins(scratch)).toEqual(xminsBefore);
      expect(await checkExists(scratch)).toBe(false);
    });
  });

  it("counts every colliding address and lists at most twenty", async () => {
    await withScratchTable(async (scratch) => {
      // 22 colliding pairs; every body has hex letters, so upper and lower differ.
      const body = (index: number) => `a${index.toString().padStart(2, "0")}${"b".repeat(37)}`;
      for (let index = 0; index < 22; index += 1) {
        await insertRow(scratch, `acct_${index}_upper`, `0x${body(index).toUpperCase()}`);
        await insertRow(scratch, `acct_${index}_lower`, `0x${body(index)}`);
      }

      await scratch.client.query("SAVEPOINT attempt");
      const error: unknown = await runMigration(scratch).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      await scratch.client.query("ROLLBACK TO SAVEPOINT attempt");

      const message = (error as Error).message;
      expect(message).toContain("lower-casing would collide on 22 address(es) (first 20 listed)");
      expect(message).toContain(`0x${body(0)} (2 claims, 0 registered)`);
      expect(message).toContain(`0x${body(19)} (2 claims, 0 registered)`);
      expect(message).not.toContain(`0x${body(20)}`);
      expect(message).not.toContain(`0x${body(21)}`);
    });
  });

  it("does not refuse once pending duplicates are legal (confirmed-only uniqueness)", async () => {
    await withScratchTable(async (scratch) => {
      // The state after the claim-lifecycle change: no plain unique index on
      // wallet_address, one unique index on lower(wallet_address) over
      // confirmed rows only.
      const plainIndex = await scratch.client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexdef ~ 'UNIQUE.*\\(wallet_address\\)$'`,
        [scratch.schema],
      );
      expect(plainIndex.rows).toHaveLength(1);
      await scratch.client.query(`DROP INDEX "${scratch.schema}"."${plainIndex.rows[0]!.indexname}"`);
      await scratch.client.query(
        `CREATE UNIQUE INDEX confirmed_address_key ON ${scratch.table} (lower(wallet_address)) WHERE registered_at IS NOT NULL`,
      );

      const body = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
      await insertRow(scratch, "acct_pending_a", `0x${body.toUpperCase()}`);
      await insertRow(scratch, "acct_pending_b", `0x${body}`);
      await insertRow(scratch, "acct_confirmed", `0xCdCdCdCdCdCdCdCdCdCdCdCdCdCdCdCdCdCdCdCd`, { registered: true });

      await runMigration(scratch);

      expect(await addresses(scratch)).toEqual({
        acct_confirmed: `0x${body}`,
        acct_pending_a: `0x${body}`,
        acct_pending_b: `0x${body}`,
      });
      expect(await checkExists(scratch)).toBe(true);
    });
  });

  it("leaves a check that rejects a mixed-case value afterwards", async () => {
    await withScratchTable(async (scratch) => {
      await insertRow(scratch, "acct_a", lowerAlready);
      await runMigration(scratch);

      await scratch.client.query("SAVEPOINT attempt");
      const error: unknown = await scratch.client
        .query(`UPDATE ${scratch.table} SET wallet_address = upper(wallet_address) WHERE account_id = 'acct_a'`)
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      await scratch.client.query("ROLLBACK TO SAVEPOINT attempt");

      expect(error).toMatchObject({ code: "23514", constraint: CHECK_NAME });
      expect(await addresses(scratch)).toEqual({ acct_a: lowerAlready });
    });
  });
});

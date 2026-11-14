import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  "../prisma/migrations/20261113150300_wallet_registration_chain_evidence/migration.sql",
);

const hash = (byte: string) => `0x${byte.repeat(32)}`;
const NEW_CONSTRAINTS = [
  "wallet_registrations_registration_evidence_shape_check",
  "wallet_registrations_registration_evidence_format_check",
  "wallet_registrations_registration_evidence_state_check",
] as const;
const NEW_INDEXES = [
  "uq_wallet_registrations_chain_event",
  "idx_wallet_registrations_tx_hash",
  "idx_wallet_registrations_evidence_recheck",
] as const;

// The migration is applied to a scratch schema holding the table as it was
// before the migration (20260916110000), loaded with rows of every kind that
// can already exist, so the data handling is tested on the real SQL file
// rather than on a copy of it. The schema name is the only substitution.
describe.skipIf(databaseUrl === undefined)("wallet registration evidence migration", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const schemas: string[] = [];
  const migrationSql = readFileSync(MIGRATION_PATH, "utf8");

  afterAll(async () => {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  async function scratchSchema(rows: string): Promise<string> {
    const schema = `s149_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    schemas.push(schema);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`
      CREATE TABLE "${schema}"."wallet_registrations" (
        "account_id" TEXT NOT NULL PRIMARY KEY,
        "wallet_address" TEXT NOT NULL,
        "registration_commitment" TEXT NOT NULL,
        "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "registered_at" TIMESTAMPTZ(6),
        "registration_tx_hash" TEXT,
        "registration_block_number" BIGINT
      );
      CREATE UNIQUE INDEX "wallet_registrations_registration_tx_hash_key"
        ON "${schema}"."wallet_registrations"("registration_tx_hash")
        WHERE "registration_tx_hash" IS NOT NULL;
    `);
    await pool.query(
      `INSERT INTO "${schema}"."wallet_registrations"
         ("account_id","wallet_address","registration_commitment","registered_at","registration_tx_hash","registration_block_number")
       VALUES ${rows}`,
    );
    return schema;
  }

  const apply = (schema: string) => pool.query(migrationSql.replaceAll('"settlement"', `"${schema}"`));

  async function constraintStates(schema: string): Promise<Record<string, boolean>> {
    const result = await pool.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = $1::regclass AND contype = 'c' ORDER BY conname`,
      [`"${schema}"."wallet_registrations"`],
    );
    return Object.fromEntries(result.rows.map((row) => [row.conname, row.convalidated]));
  }

  async function indexNames(schema: string): Promise<string[]> {
    const result = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'wallet_registrations' ORDER BY indexname`,
      [schema],
    );
    return result.rows.map((row) => row.indexname);
  }

  // The find-violators queries from the migration's own header comment, run
  // against the scratch schema.
  function headerQueries(schema: string): string[] {
    const header = migrationSql.slice(
      migrationSql.indexOf("-- To find rows that violate"),
      migrationSql.indexOf("-- Informational"),
    );
    const text = header
      .split("\n")
      .slice(1)
      .map((line) => line.replace(/^--\s?/, ""))
      .join("\n");
    return text
      .split(";")
      .map((query) => query.trim())
      .filter((query) => query.startsWith("SELECT"))
      .map((query) => query.replaceAll("settlement.wallet_registrations", `"${schema}"."wallet_registrations"`));
  }

  beforeAll(() => {
    expect(migrationSql).toContain("uq_wallet_registrations_chain_event");
  });

  it("applies to clean legacy rows: lower-cases hashes, validates every constraint, swaps the unique index", async () => {
    const schema = await scratchSchema(`
      ('watcher', '0xw1', 'c1', now(), NULL, NULL),
      ('manual', '0xm1', 'c2', now(), '0x${"AB".repeat(32)}', 100),
      ('pending', '0xp1', 'c3', NULL, NULL, NULL)`);

    await apply(schema);

    const rows = await pool.query<{ account_id: string; registration_tx_hash: string | null; registration_log_index: number | null }>(
      `SELECT account_id, registration_tx_hash, registration_log_index FROM "${schema}"."wallet_registrations" ORDER BY account_id`,
    );
    expect(rows.rows).toEqual([
      { account_id: "manual", registration_tx_hash: hash("ab"), registration_log_index: null },
      { account_id: "pending", registration_tx_hash: null, registration_log_index: null },
      { account_id: "watcher", registration_tx_hash: null, registration_log_index: null },
    ]);
    expect(await constraintStates(schema)).toEqual({
      [NEW_CONSTRAINTS[0]]: true,
      [NEW_CONSTRAINTS[1]]: true,
      [NEW_CONSTRAINTS[2]]: true,
    });
    const indexes = await indexNames(schema);
    expect(indexes).not.toContain("wallet_registrations_registration_tx_hash_key");
    for (const name of NEW_INDEXES) expect(indexes).toContain(name);
    for (const query of headerQueries(schema)) {
      expect((await pool.query(query)).rows).toEqual([]);
    }
  });

  it("can be applied twice with the same outcome", async () => {
    const schema = await scratchSchema(`('manual', '0xm1', 'c2', now(), '0x${"AB".repeat(32)}', 100)`);

    await apply(schema);
    const firstConstraints = await constraintStates(schema);
    const firstIndexes = await indexNames(schema);
    await apply(schema);

    expect(await constraintStates(schema)).toEqual(firstConstraints);
    expect(await indexNames(schema)).toEqual(firstIndexes);
    const row = await pool.query(`SELECT registration_tx_hash FROM "${schema}"."wallet_registrations"`);
    expect(row.rows).toEqual([{ registration_tx_hash: hash("ab") }]);
  });

  it("still applies over malformed legacy rows, leaves the violated constraints NOT VALID and the header queries find the rows", async () => {
    const schema = await scratchSchema(`
      ('badhash', '0xb1', 'c4', now(), '0xnothex', 5),
      ('nonumber', '0xb2', 'c5', now(), '0x${"cd".repeat(32)}', NULL),
      ('fine', '0xb3', 'c6', now(), '0x${"ef".repeat(32)}', 7)`);

    await apply(schema);

    expect(await constraintStates(schema)).toEqual({
      [NEW_CONSTRAINTS[0]]: false,
      [NEW_CONSTRAINTS[1]]: false,
      [NEW_CONSTRAINTS[2]]: true,
    });
    const [shapeQuery, formatQuery, stateQuery] = headerQueries(schema);
    expect((await pool.query(shapeQuery!)).rows.map((row) => row.account_id)).toEqual(["nonumber"]);
    expect((await pool.query(formatQuery!)).rows.map((row) => row.account_id)).toEqual(["badhash"]);
    expect((await pool.query(stateQuery!)).rows).toEqual([]);

    // The migration is still safe to run again, and the clean row is untouched.
    await apply(schema);
    const fine = await pool.query(`SELECT registration_tx_hash FROM "${schema}"."wallet_registrations" WHERE account_id = 'fine'`);
    expect(fine.rows).toEqual([{ registration_tx_hash: hash("ef") }]);
  });

  it("makes (transaction hash, log index) the unique identity and lets legacy rows share a hash", async () => {
    const schema = await scratchSchema(`
      ('a', '0xa', 'ca', now(), NULL, NULL),
      ('b', '0xb', 'cb', now(), NULL, NULL),
      ('c', '0xc', 'cc', now(), NULL, NULL),
      ('d', '0xd', 'cd', now(), NULL, NULL)`);
    await apply(schema);
    const table = `"${schema}"."wallet_registrations"`;
    const confirm = (account: string, tx: string, block: string, logIndex: number | null) =>
      pool.query(
        `UPDATE ${table} SET registration_tx_hash = $2, registration_block_number = 10,
                registration_block_hash = $3, registration_log_index = $4 WHERE account_id = $1`,
        [account, tx, block, logIndex],
      );

    // Two registrations in one transaction, at log indexes 3 and 5.
    await confirm("a", hash("11"), hash("22"), 3);
    await confirm("b", hash("11"), hash("22"), 5);
    // The same event twice is rejected, by the named index.
    await expect(confirm("c", hash("11"), hash("22"), 3)).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_wallet_registrations_chain_event",
    });
    // A legacy row (no log index) is outside the index, so it can share a hash.
    await pool.query(
      `UPDATE ${table} SET registration_tx_hash = $2, registration_block_number = 10 WHERE account_id = $1`,
      ["c", hash("11")],
    );
    await pool.query(
      `UPDATE ${table} SET registration_tx_hash = $2, registration_block_number = 10 WHERE account_id = $1`,
      ["d", hash("11")],
    );
  });
});

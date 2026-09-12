import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { AUTHENTICATION_LEVELS } from "../src/modules/auth/infrastructure/better-auth.factory.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// After the Phase 4 cutover migration (20260912150000_remove_oauth_passkey_level),
// the database's own check on auth_session.authenticationLevel matches the
// levels the factory can write: oauth_passkey is gone, the rest remain.
describe.skipIf(databaseUrl === undefined)("auth_session authentication levels, Postgres", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  it("allows exactly the factory's levels, and no longer oauth_passkey", async () => {
    const result = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'auth_session_authentication_level_check'`,
    );
    const definition = result.rows[0]?.definition ?? "";

    expect(definition).not.toContain("oauth_passkey");
    for (const level of AUTHENTICATION_LEVELS) {
      expect(definition).toContain(`'${level}'`);
    }
    expect(AUTHENTICATION_LEVELS).not.toContain("oauth_passkey");
  });

  it("holds no oauth_passkey sessions", async () => {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM "auth_session" WHERE "authenticationLevel" = 'oauth_passkey'`,
    );
    expect(Number(result.rows[0]?.count)).toBe(0);
  });
});

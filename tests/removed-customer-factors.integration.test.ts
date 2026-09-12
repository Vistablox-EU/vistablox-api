import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// Device-bound auth, Phase 4 (direct cutover): customer recovery codes, TOTP
// backup codes and customer TOTP itself are gone. After the migrations, none
// of their tables exist.
describe.skipIf(databaseUrl === undefined)("removed customer auth factors, Postgres", () => {
  const database = createPrismaClient(databaseUrl ?? "");

  afterAll(async () => {
    await database.$disconnect();
  });

  it.each(["auth.mfa_totp_factors", "auth.mfa_backup_codes", "auth.account_recovery_codes"])(
    "%s no longer exists",
    async (table) => {
      const rows = await database.$queryRaw<Array<{ present: string | null }>>`
        SELECT to_regclass(${table})::text AS present
      `;
      expect(rows[0]?.present).toBeNull();
    },
  );
});

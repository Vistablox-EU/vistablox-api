import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaStaffWebAuthnRepository } from "../src/modules/auth/repository/prisma-staff-webauthn.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("staff WebAuthn repository PostgreSQL integration", () => {
  const suffix = randomUUID();
  const accountId = `acct_${suffix}`;
  const betterAuthUserId = `auth_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const repository = new PrismaStaffWebAuthnRepository(database);

  beforeAll(async () => {
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Staff WebAuthn Test User", `${betterAuthUserId}@example.test`, true, "staff_partner"],
    );
    await database.account.create({
      data: {
        id: accountId,
        betterAuthUserId,
        protectedContactEmail: `${betterAuthUserId}@example.test`,
        staffRoles: { create: { id: `role_${betterAuthUserId}`, role: "admin_operations" } },
      },
    });
  });

  afterAll(async () => {
    await database.session.deleteMany({ where: { accountId } });
    await database.staffRoleAssignment.deleteMany({ where: { accountId } });
    await database.account.deleteMany({ where: { id: accountId } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  it("verifies a real staff passkey session, whose auth_method_at_login is 'staff_passkey'", async () => {
    // resolveLoginMethod() in better-auth-audit.plugin.ts writes "staff_passkey"
    // for every staff passkey ceremony today; "passkey" is never written by
    // any code path, so a query for that literal always missed.
    const providerSessionId = `provider_${suffix}_verified`;
    await database.session.create({
      data: {
        id: `session_${suffix}_verified`,
        accountId,
        channel: "web",
        betterAuthUserId,
        betterAuthSessionId: providerSessionId,
        authMethodAtLogin: "staff_passkey",
        idleExpiresAt: new Date("2026-09-13T13:00:00.000Z"),
        absoluteExpiresAt: new Date("2026-09-13T20:00:00.000Z"),
      },
    });

    await expect(repository.isSessionVerified(accountId, providerSessionId)).resolves.toBe(true);
  });

  it("does not verify a session that never completed a staff passkey ceremony", async () => {
    const providerSessionId = `provider_${suffix}_unverified`;
    await database.session.create({
      data: {
        id: `session_${suffix}_unverified`,
        accountId,
        channel: "web",
        betterAuthUserId,
        betterAuthSessionId: providerSessionId,
        authMethodAtLogin: "oauth_pending",
        idleExpiresAt: new Date("2026-09-13T13:00:00.000Z"),
        absoluteExpiresAt: new Date("2026-09-13T20:00:00.000Z"),
      },
    });

    await expect(repository.isSessionVerified(accountId, providerSessionId)).resolves.toBe(false);
  });
});

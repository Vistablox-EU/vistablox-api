import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { BetterAuthStaffAccountAdministrator } from "../src/modules/auth/infrastructure/better-auth-staff-account-administrator.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { PrismaStaffAccountLifecycleRepository } from "../src/modules/auth/repository/prisma-staff-account-lifecycle.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("staff account lifecycle PostgreSQL integration", () => {
  const suffix = randomUUID();
  const email = `staff-lifecycle-${suffix}@example.test`;
  const password = `A uniquely generated VistaBlox test password ${suffix}`;
  const accountId = `acct_${suffix}`;
  const credentialId = `credential_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const resetUrls: string[] = [];
  const auth = createBetterAuth({
    database: authPool,
    baseURL: "http://localhost:3000",
    secret: "integration-test-secret-that-is-at-least-32-characters",
    secureCookies: false,
    trustedOrigins: ["http://localhost:3000"],
    allowPopulationInput: true,
    sendPasswordResetEmail: async ({ resetUrl }) => {
      resetUrls.push(resetUrl);
    },
  });
  const administrator = new BetterAuthStaffAccountAdministrator(auth);
  const repository = new PrismaStaffAccountLifecycleRepository(database);
  let betterAuthUserId = "";

  beforeAll(async () => {
    const signedUp = await auth.api.signUpEmail({
      body: {
        name: "Lifecycle Test Staff",
        email,
        password,
        population: "staff_partner",
      },
    });
    betterAuthUserId = signedUp.user.id;
    await database.account.create({
      data: {
        id: accountId,
        betterAuthUserId,
        status: "active",
        staffRoles: {
          create: {
            id: `role_${suffix}`,
            role: "admin_operations",
          },
        },
        staffWebAuthnCredentials: {
          create: {
            id: credentialId,
            publicKey: new Uint8Array([1, 2, 3]),
            counter: 0,
            deviceType: "singleDevice",
            backedUp: false,
            transports: ["internal"],
          },
        },
      },
    });
  }, 30_000);

  afterAll(async () => {
    if (betterAuthUserId !== "") {
      await database.auditLog.deleteMany({
        where: { OR: [{ actorAccountId: accountId }, { resourceId: accountId }] },
      });
      await database.staffRoleAssignment.deleteMany({ where: { accountId } });
      await database.account.deleteMany({ where: { id: accountId } });
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [
        betterAuthUserId,
      ]);
    }
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  it("revokes recovery access, delivers reset, and blocks login after offboarding", async () => {
    await administrator.prepareRecovery({
      betterAuthUserId,
      recoveryRequiredAt: new Date(),
    });
    const prepared = await repository.prepareRecovery({
      accountId,
      actorAccountId: accountId,
      traceId: `trace_${suffix}`,
      preparedAt: new Date(),
    });
    await administrator.sendRecoveryEmail({
      betterAuthUserId,
      redirectTo: "http://localhost:3000/staff/reset-password",
      traceId: `trace_${suffix}`,
    });

    expect(prepared).toBe(true);
    expect(await database.staffWebAuthnCredential.count({ where: { accountId } })).toBe(0);
    expect(resetUrls).toHaveLength(1);
    expect(resetUrls[0]).toContain("/api/auth/reset-password/");
    expect(resetUrls[0]).not.toContain(email);
    expect(
      await authPool.query('SELECT 1 FROM "auth_session" WHERE "userId" = $1', [
        betterAuthUserId,
      ]),
    ).toMatchObject({ rowCount: 0 });

    await expect(
      auth.api.signInEmail({ body: { email, password } }),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "STAFF_ACCOUNT_RECOVERY_REQUIRED" },
    });
    const resetToken = new URL(resetUrls[0] ?? "").pathname.split("/").at(-1);
    expect(resetToken).toBeTruthy();
    const newPassword = `${password} reset`;
    await auth.api.resetPassword({
      body: { newPassword, token: resetToken },
    });
    const recovered = await authPool.query<{ recoveryRequiredAt: Date | null }>(
      'SELECT "recoveryRequiredAt" FROM "auth_user" WHERE "id" = $1',
      [betterAuthUserId],
    );
    expect(recovered.rows[0]).toMatchObject({ recoveryRequiredAt: null });
    await auth.api.signInEmail({ body: { email, password: newPassword } });
    await administrator.disableAndRevoke({
      betterAuthUserId,
      reason: "partner_firm_notice",
      disabledAt: new Date(),
    });
    await repository.completeOffboarding({
      accountId,
      actorAccountId: accountId,
      traceId: `trace_${suffix}`,
      reason: "partner_firm_notice",
      completedAt: new Date(),
    });

    const disabled = await authPool.query<{
      disabledAt: Date | null;
      disabledReason: string | null;
    }>(
      'SELECT "disabledAt", "disabledReason" FROM "auth_user" WHERE "id" = $1',
      [betterAuthUserId],
    );
    expect(disabled.rows[0]).toMatchObject({
      disabledAt: expect.any(Date),
      disabledReason: "partner_firm_notice",
    });
    expect(
      await authPool.query('SELECT 1 FROM "auth_session" WHERE "userId" = $1', [
        betterAuthUserId,
      ]),
    ).toMatchObject({ rowCount: 0 });
    await expect(
      auth.api.signInEmail({ body: { email, password: newPassword } }),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "STAFF_ACCOUNT_DISABLED" },
    });
    expect(await database.account.findUnique({ where: { id: accountId } })).toMatchObject({
      status: "suspended_restricted",
    });
    expect(
      await database.staffRoleAssignment.count({
        where: { accountId, revokedAt: null },
      }),
    ).toBe(0);
    expect(
      await database.auditLog.count({
        where: {
          resourceId: accountId,
          action: {
            in: [
              "authentication.staff_account_recovery_started",
              "authentication.staff_account_offboarded",
            ],
          },
        },
      }),
    ).toBe(2);
  }, 30_000);
});

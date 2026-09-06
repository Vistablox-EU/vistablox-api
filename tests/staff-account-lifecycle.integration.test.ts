import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";
import { BetterAuthStaffAccountAdministrator } from "../src/modules/auth/infrastructure/better-auth-staff-account-administrator.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { PrismaStaffAccountLifecycleRepository } from "../src/modules/auth/repository/prisma-staff-account-lifecycle.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("staff account lifecycle PostgreSQL integration", () => {
  const suffix = randomUUID();
  const email = `staff-lifecycle-${suffix}@example.test`;
  const accountId = `acct_${suffix}`;
  const credentialId = `credential_${suffix}`;
  const rosterEmail = `staff-roster-${suffix}@example.test`;
  const rosterAccountId = `acct_roster_${suffix}`;
  const legalPracticeId = `practice_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const recoveryUrls: string[] = [];
  const auth = createBetterAuth({
    database: authPool,
    baseURL: "http://localhost:3000",
    secret: "integration-test-secret-that-is-at-least-32-characters",
    secureCookies: false,
    trustedOrigins: ["http://localhost:3000"],
    allowPopulationInput: true,
  });
  const recoveryEmailSender = {
    sendPasskeyRecoveryEmail: async ({ recoveryUrl }: { recoveryUrl: string }) => {
      recoveryUrls.push(recoveryUrl);
    },
  } as unknown as EmailSender;
  const administrator = new BetterAuthStaffAccountAdministrator(auth, recoveryEmailSender);
  const repository = new PrismaStaffAccountLifecycleRepository(database);
  let betterAuthUserId = "";
  let rosterBetterAuthUserId = "";

  beforeAll(async () => {
    const authContext = await auth.$context;
    const created = await authContext.internalAdapter.createUser({
      name: "Lifecycle Test Staff",
      email,
      emailVerified: true,
      population: "staff_partner",
    }, { method: "internal" });
    betterAuthUserId = created.id;
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

    const rosterCreated = await authContext.internalAdapter.createUser({
      name: "Roster Test Staff",
      email: rosterEmail,
      emailVerified: true,
      population: "staff_partner",
    }, { method: "internal" });
    rosterBetterAuthUserId = rosterCreated.id;
    await database.legalPractice.create({
      data: { id: legalPracticeId, name: "Roster Test Legal Practice", countryCode: "NL" },
    });
    await database.account.create({
      data: {
        id: rosterAccountId,
        betterAuthUserId: rosterBetterAuthUserId,
        status: "active",
        staffRoles: {
          create: {
            id: `role_roster_${suffix}`,
            role: "admin_operations",
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
    if (rosterBetterAuthUserId !== "") {
      await database.auditLog.deleteMany({
        where: { OR: [{ actorAccountId: rosterAccountId }, { resourceId: rosterAccountId }] },
      });
      await database.staffRoleAssignment.deleteMany({ where: { accountId: rosterAccountId } });
      await database.account.deleteMany({ where: { id: rosterAccountId } });
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [
        rosterBetterAuthUserId,
      ]);
    }
    // After staffRoleAssignment rows are gone (both branches above), so
    // legal_practices' FK from staff_role_assignments.legal_practice_id no
    // longer references this row.
    await database.legalPractice.deleteMany({ where: { id: legalPracticeId } });
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  it("revokes recovery access, delivers passkey enrollment, and offboards", async () => {
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
      redirectTo: "http://localhost:3000/staff/recover-account",
      traceId: `trace_${suffix}`,
    });

    expect(prepared).toBe(true);
    expect(await database.staffWebAuthnCredential.count({ where: { accountId } })).toBe(0);
    expect(recoveryUrls).toHaveLength(1);
    expect(recoveryUrls[0]).toContain("/staff/recover-account?context=");
    expect(recoveryUrls[0]).not.toContain(email);
    expect(
      await authPool.query('SELECT 1 FROM "auth_session" WHERE "userId" = $1', [
        betterAuthUserId,
      ]),
    ).toMatchObject({ rowCount: 0 });

    const recovering = await authPool.query<{ recoveryRequiredAt: Date | null }>(
      'SELECT "recoveryRequiredAt" FROM "auth_user" WHERE "id" = $1',
      [betterAuthUserId],
    );
    expect(recovering.rows[0]).toMatchObject({ recoveryRequiredAt: expect.any(Date) });
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

  it("rosters, grants, and revokes individual role assignments", async () => {
    const rosterBeforeGrant = await repository.listStaffAccounts();
    const rosteredTarget = rosterBeforeGrant.find((entry) => entry.accountId === rosterAccountId);
    expect(rosteredTarget).toMatchObject({
      accountId: rosterAccountId,
      email: null,
      status: "active",
      roles: [expect.objectContaining({ role: "admin_operations", revokedAt: null })],
    });

    expect(
      await repository.hasActiveRole({ accountId: rosterAccountId, role: "legal_partner" }),
    ).toBe(false);

    const granted = await repository.grantRole({
      accountId: rosterAccountId,
      role: "legal_partner",
      legalPracticeId,
      appraisalFirmId: null,
      actorAccountId: rosterAccountId,
      traceId: `trace_grant_${suffix}`,
      grantedAt: new Date(),
    });
    expect(granted).toMatchObject({
      role: "legal_partner",
      legalPracticeId,
      appraisalFirmId: null,
      revokedAt: null,
    });
    expect(
      await repository.hasActiveRole({ accountId: rosterAccountId, role: "legal_partner" }),
    ).toBe(true);

    const rosterAfterGrant = await repository.listStaffAccounts();
    expect(
      rosterAfterGrant.find((entry) => entry.accountId === rosterAccountId)?.roles,
    ).toHaveLength(2);

    const revoked = await repository.revokeRole({
      accountId: rosterAccountId,
      assignmentId: granted.assignmentId,
      actorAccountId: rosterAccountId,
      traceId: `trace_revoke_${suffix}`,
      revokedAt: new Date(),
    });
    expect(revoked).toMatchObject({ assignmentId: granted.assignmentId, revokedAt: expect.any(Date) });
    expect(
      await repository.hasActiveRole({ accountId: rosterAccountId, role: "legal_partner" }),
    ).toBe(false);

    const repeatRevoke = await repository.revokeRole({
      accountId: rosterAccountId,
      assignmentId: granted.assignmentId,
      actorAccountId: rosterAccountId,
      traceId: `trace_revoke_again_${suffix}`,
      revokedAt: new Date(),
    });
    expect(repeatRevoke).toBeNull();

    const otherAccountRevoke = await repository.revokeRole({
      accountId: `acct_nonexistent_${suffix}`,
      assignmentId: granted.assignmentId,
      actorAccountId: rosterAccountId,
      traceId: `trace_revoke_wrong_account_${suffix}`,
      revokedAt: new Date(),
    });
    expect(otherAccountRevoke).toBeNull();

    expect(
      await database.auditLog.count({
        where: {
          resourceId: rosterAccountId,
          action: {
            in: ["authentication.staff_role_granted", "authentication.staff_role_revoked"],
          },
        },
      }),
    ).toBe(2);
  }, 30_000);
});

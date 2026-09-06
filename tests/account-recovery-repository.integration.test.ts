import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaAccountRecoveryRepository } from "../src/modules/auth/repository/prisma-account-recovery.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("account recovery PostgreSQL integration", () => {
  const suffix = randomUUID();
  const accountId = `acct_${suffix}`;
  const betterAuthUserId = `auth_${suffix}`;
  const reviewerOneId = `acct_reviewer_one_${suffix}`;
  const reviewerOneAuthId = `auth_reviewer_one_${suffix}`;
  const reviewerTwoId = `acct_reviewer_two_${suffix}`;
  const reviewerTwoAuthId = `auth_reviewer_two_${suffix}`;
  const staffAccountId = `acct_staff_${suffix}`;
  const staffAuthId = `auth_staff_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const repository = new PrismaAccountRecoveryRepository(database);

  beforeAll(async () => {
    for (const [id, authId, isStaff] of [
      [accountId, betterAuthUserId, false],
      [reviewerOneId, reviewerOneAuthId, false],
      [reviewerTwoId, reviewerTwoAuthId, false],
      [staffAccountId, staffAuthId, true],
    ] as const) {
      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [authId, "Recovery Test User", `${authId}@example.test`, true, "customer"],
      );
      await database.account.create({
        data: {
          id,
          betterAuthUserId: authId,
          protectedContactEmail: `${authId}@example.test`,
          ...(isStaff
            ? { staffRoles: { create: { id: `role_${authId}`, role: "admin_operations" } } }
            : {}),
        },
      });
    }
    await database.session.create({
      data: {
        id: `session_${suffix}`,
        accountId,
        channel: "web",
        betterAuthUserId,
        authMethodAtLogin: "oauth_passkey",
        idleExpiresAt: new Date("2026-09-02T13:00:00.000Z"),
        absoluteExpiresAt: new Date("2026-09-02T20:00:00.000Z"),
      },
    });
  });

  afterAll(async () => {
    await database.auditLog.deleteMany({
      where: { resourceType: "account_recovery_case", resourceId: { contains: suffix } },
    });
    await database.accountRecoveryCase.deleteMany({ where: { accountId } });
    await database.accountRecoveryCode.deleteMany({ where: { accountId } });
    await database.session.deleteMany({ where: { accountId } });
    await database.staffRoleAssignment.deleteMany({ where: { accountId: staffAccountId } });
    await database.account.deleteMany({
      where: { id: { in: [accountId, reviewerOneId, reviewerTwoId, staffAccountId] } },
    });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = ANY($1)', [
      [betterAuthUserId, reviewerOneAuthId, reviewerTwoAuthId, staffAuthId],
    ]);
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  it("identifies a staff account so it can be rejected as a recovery target", async () => {
    const staffTarget = await repository.findTargetForRecovery(staffAccountId);
    const customerTarget = await repository.findTargetForRecovery(accountId);

    expect(staffTarget?.isStaff).toBe(true);
    expect(customerTarget?.isStaff).toBe(false);
    expect(customerTarget?.contactEmail).toBe(`${betterAuthUserId}@example.test`);
  });

  it("surfaces the last login as a corroboration fact", async () => {
    const facts = await repository.getCorroborationFacts(accountId);

    expect(facts.lastLogin).toMatchObject({ authMethod: "oauth_passkey" });
    expect(facts.lastDeposit).toBeNull();
    expect(facts.lastReservation).toBeNull();
  });

  it("drives a case through the full lifecycle: open, Didit session, dual review, and completion", async () => {
    const openedAt = new Date("2026-09-02T12:00:00.000Z");
    await database.accountRecoveryCode.create({
      data: { accountId, codeHash: "old-code-hash", createdAt: openedAt },
    });
    const opened = await repository.openCase({
      accountId,
      actorAccountId: staffAccountId,
      traceId: `trace_${suffix}`,
      openedAt,
    });
    expect(opened.status).toBe("open");

    const invalidatedCode = await database.accountRecoveryCode.findUniqueOrThrow({
      where: { accountId },
    });
    expect(invalidatedCode.consumedAt?.toISOString()).toBe(openedAt.toISOString());

    const restrictedAccount = await database.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(restrictedAccount.status).toBe("recovery_review");

    const openedAudit = await database.auditLog.findFirst({
      where: { action: "authentication.account_recovery_case_opened", resourceId: opened.id },
    });
    expect(openedAudit).not.toBeNull();

    expect(await repository.findOpenCaseForAccount(accountId)).toMatchObject({ id: opened.id });

    // A primary review before any Didit session exists is rejected atomically.
    const primaryBeforeDidit = await repository.recordPrimaryReview({
      caseId: opened.id,
      reviewerAccountId: reviewerOneId,
      corroborationCategory: "last_login",
      traceId: `trace_${suffix}`,
      reviewedAt: openedAt,
    });
    expect(primaryBeforeDidit).toBeNull();

    const withDiditSession = await repository.recordDiditSession({
      caseId: opened.id,
      diditReference: `didit_${suffix}`,
      actorAccountId: staffAccountId,
      traceId: `trace_${suffix}`,
      recordedAt: openedAt,
    });
    expect(withDiditSession?.freshDiditVerificationRef).toBe(`didit_${suffix}`);

    const primaryReviewed = await repository.recordPrimaryReview({
      caseId: opened.id,
      reviewerAccountId: reviewerOneId,
      corroborationCategory: "last_login",
      traceId: `trace_${suffix}`,
      reviewedAt: openedAt,
    });
    expect(primaryReviewed?.reviewedByPrimary).toBe(reviewerOneId);

    // The same reviewer deciding their own primary review is rejected atomically.
    const sameReviewerDecision = await repository.decideCase({
      caseId: opened.id,
      reviewerAccountId: reviewerOneId,
      decision: "approved",
      reason: "should not apply",
      traceId: `trace_${suffix}`,
      decidedAt: openedAt,
    });
    expect(sameReviewerDecision).toBeNull();

    const decided = await repository.decideCase({
      caseId: opened.id,
      reviewerAccountId: reviewerTwoId,
      decision: "approved",
      reason: "Corroboration and Didit verification both checked out.",
      traceId: `trace_${suffix}`,
      decidedAt: openedAt,
    });
    expect(decided).toMatchObject({
      status: "approved",
      reviewedByPrimary: reviewerOneId,
      reviewedBySecondary: reviewerTwoId,
    });

    const completedAt = new Date("2026-09-02T13:00:00.000Z");
    const cooldownEndsAt = new Date(completedAt.getTime() + 72 * 60 * 60 * 1000);
    const completed = await repository.completeCase({
      caseId: opened.id,
      actorAccountId: staffAccountId,
      traceId: `trace_${suffix}`,
      completedAt,
      cooldownEndsAt,
    });
    expect(completed).toMatchObject({ status: "completed" });
    expect(completed?.cooldownEndsAt?.toISOString()).toBe(cooldownEndsAt.toISOString());

    const restoredAccount = await database.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(restoredAccount.status).toBe("active");

    const activeCooldown = await repository.getActiveCooldown(accountId, completedAt);
    expect(activeCooldown?.toISOString()).toBe(cooldownEndsAt.toISOString());

    const lapsedCooldown = await repository.getActiveCooldown(
      accountId,
      new Date(cooldownEndsAt.getTime() + 1000),
    );
    expect(lapsedCooldown).toBeNull();
  });
});

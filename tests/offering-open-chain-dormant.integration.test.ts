import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// AD-234: production launches with token settlement dormant, so the worker has
// no chain config and never creates (or consumes) the
// settlement.open_ipo_escrow_campaign queue. Opening an offering must still
// work then. Before openEscrowCampaign existed, the open transaction always
// enqueued that job, pg-boss threw "Queue ... does not exist", and the whole
// open rolled back -- so no approved case could ever become a browsable
// offering. These tests use a pg-boss schema of their own so "the queue does
// not exist" holds regardless of which queues other test files have created in
// the shared pgboss schema.
describe.skipIf(databaseUrl === undefined)(
  "opening an offering while chain settlement is dormant PostgreSQL integration (AD-234)",
  () => {
    const suffix = randomUUID();
    const bossSchema = `pgboss_dormant_${suffix.replaceAll("-", "").slice(0, 16)}`;
    const accountId = `account_dormant_${suffix}`;
    const betterAuthUserId = `auth_dormant_${suffix}`;
    const authPool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");
    // Constructed in beforeAll, not at describe-body scope: the body runs even
    // when skipIf skips every test and databaseUrl is undefined.
    let boss: PgBoss;
    let repository: PrismaOfferingRepository;
    const propertyIds: string[] = [];
    const caseIds: string[] = [];
    const offeringIds: string[] = [];

    async function createCase(ipoEndAt: Date | null): Promise<{ caseId: string; propertyId: string }> {
      const id = randomUUID();
      const propertyId = `property_dormant_${id}`;
      const caseId = `case_dormant_${id}`;
      await database.property.create({
        data: {
          id: propertyId,
          countryCode: "RS",
          city: "Novi Sad",
          addressLine: "Dormant Chain Test 1",
          ownerDeclaredValueEur: "220000.00",
        },
      });
      await database.intakeCase.create({
        data: {
          id: caseId,
          propertyId,
          applicantAccountId: accountId,
          stage: "pre_offering_open",
          legalExecutionEventRefs: [],
          legalDocumentRefs: [],
          appraisalDocumentRefs: [],
          ipoEndAt,
        },
      });
      propertyIds.push(propertyId);
      caseIds.push(caseId);
      return { caseId, propertyId };
    }

    async function jobsFor(queueName: string): Promise<Array<{ name: string; data: Record<string, unknown> }>> {
      const { rows } = await authPool.query<{ name: string; data: Record<string, unknown> }>(
        `SELECT name, data FROM "${bossSchema}".job WHERE name = $1`,
        [queueName],
      );
      return rows;
    }

    beforeAll(async () => {
      boss = new PgBoss({ connectionString: databaseUrl ?? "", schema: bossSchema });
      repository = new PrismaOfferingRepository(database, boss, new PrismaKycRepository(database, boss));
      await boss.start();
      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [betterAuthUserId, "Dormant Chain Applicant", `dormant-${suffix}@example.test`, true, "customer"],
      );
      await database.account.create({ data: { id: accountId, betterAuthUserId } });
    }, 30_000);

    afterAll(async () => {
      // Each step is guarded so one failure (a test that left a Piv this list
      // does not know about trips a RESTRICT foreign key) cannot skip the
      // rest and leak the private pg-boss schema and its live timers.
      const steps: Array<() => Promise<unknown>> = [
        () =>
          database.auditLog.deleteMany({
            where: { OR: [{ resourceId: { in: caseIds } }, { resourceId: { in: offeringIds }, resourceType: "offering" }] },
          }),
        () => database.offering.deleteMany({ where: { piv: { propertyId: { in: propertyIds } } } }),
        () => database.piv.deleteMany({ where: { propertyId: { in: propertyIds } } }),
        () => database.intakeCase.deleteMany({ where: { id: { in: caseIds } } }),
        () => database.property.deleteMany({ where: { id: { in: propertyIds } } }),
        () => database.account.deleteMany({ where: { id: accountId } }),
        () => authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]),
        () => boss.stop({ graceful: false }),
        () => authPool.query(`DROP SCHEMA IF EXISTS "${bossSchema}" CASCADE`),
        () => database.$disconnect(),
        () => authPool.end(),
      ];
      const failures: unknown[] = [];
      for (const step of steps) {
        try {
          await step();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "dormant-chain test cleanup failed");
    }, 30_000);

    it("opens the offering and enqueues nothing when the escrow campaign job has no consumer", async () => {
      const { caseId, propertyId } = await createCase(new Date("2026-10-01T19:00:00.000Z"));

      const opened = await repository.openOfferingForApprovedCase({
        caseId,
        propertyId,
        ipoValueEur: "220000.00",
        traceId: `trace_dormant_${suffix}`,
        openedAt: new Date("2026-09-01T19:00:00.000Z"),
        openEscrowCampaign: false,
      });
      offeringIds.push(opened.offeringId);

      expect(await database.offering.findUnique({ where: { id: opened.offeringId } })).toMatchObject({
        pivId: opened.pivId,
        status: "pre_offering",
      });
      expect(await database.piv.findUnique({ where: { id: opened.pivId } })).toMatchObject({ propertyId, caseId });
      expect(await jobsFor("settlement.open_ipo_escrow_campaign")).toEqual([]);
    });

    it("enqueues the campaign-opening job in the same transaction when a consumer is configured", async () => {
      await boss.createQueue("settlement.open_ipo_escrow_campaign");
      const ipoEndAt = new Date("2026-10-01T19:00:00.000Z");
      const { caseId, propertyId } = await createCase(ipoEndAt);

      const opened = await repository.openOfferingForApprovedCase({
        caseId,
        propertyId,
        ipoValueEur: "220000.00",
        traceId: `trace_enabled_${suffix}`,
        openedAt: new Date("2026-09-01T19:00:00.000Z"),
        openEscrowCampaign: true,
      });
      offeringIds.push(opened.offeringId);

      const piv = await database.piv.findUniqueOrThrow({ where: { id: opened.pivId } });
      const jobs = (await jobsFor("settlement.open_ipo_escrow_campaign")).filter(
        (job) => job.data.piv_id === opened.pivId,
      );
      expect(piv.tokenId).not.toBeNull();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.data).toEqual({
        piv_id: opened.pivId,
        token_id: piv.tokenId?.toString(),
        target_amount_eurc: "220000000000",
        deadline_unix: Math.floor(ipoEndAt.getTime() / 1_000),
        trace_id: `trace_enabled_${suffix}`,
      });

      // A replay of the same handoff job (a pg-boss retry) takes the
      // existing-Piv branch and must not queue a second campaign.
      const replayed = await repository.openOfferingForApprovedCase({
        caseId,
        propertyId,
        ipoValueEur: "220000.00",
        traceId: `trace_enabled_replay_${suffix}`,
        openedAt: new Date("2026-09-01T19:05:00.000Z"),
        openEscrowCampaign: true,
      });
      expect(replayed).toEqual(opened);
      expect(
        (await jobsFor("settlement.open_ipo_escrow_campaign")).filter((job) => job.data.piv_id === opened.pivId),
      ).toHaveLength(1);
    });

    it("does not need an IPO deadline to open an offering while dormant, only to schedule a campaign", async () => {
      const { caseId, propertyId } = await createCase(null);

      const opened = await repository.openOfferingForApprovedCase({
        caseId,
        propertyId,
        ipoValueEur: "220000.00",
        traceId: `trace_no_deadline_${suffix}`,
        openedAt: new Date("2026-09-01T19:00:00.000Z"),
        openEscrowCampaign: false,
      });
      offeringIds.push(opened.offeringId);
      expect(await database.offering.findUnique({ where: { id: opened.offeringId } })).toMatchObject({
        pivId: opened.pivId,
      });

      const other = await createCase(null);
      await expect(
        repository.openOfferingForApprovedCase({
          caseId: other.caseId,
          propertyId: other.propertyId,
          ipoValueEur: "220000.00",
          traceId: `trace_no_deadline_enabled_${suffix}`,
          openedAt: new Date("2026-09-01T19:00:00.000Z"),
          openEscrowCampaign: true,
        }),
      ).rejects.toThrow(/no ipo_end_at/);
      expect(await database.piv.count({ where: { propertyId: other.propertyId } })).toBe(0);
    });

    it("rolls the whole open back, leaving no Piv or offering, when the job is required but its queue is missing", async () => {
      // A fresh schema's queue list only has what the previous test created, so
      // delete it to recreate the dormant worker's state for this case.
      await boss.deleteQueue("settlement.open_ipo_escrow_campaign");
      const { caseId, propertyId } = await createCase(new Date("2026-10-01T19:00:00.000Z"));

      await expect(
        repository.openOfferingForApprovedCase({
          caseId,
          propertyId,
          ipoValueEur: "220000.00",
          traceId: `trace_required_${suffix}`,
          openedAt: new Date("2026-09-01T19:00:00.000Z"),
          openEscrowCampaign: true,
        }),
      ).rejects.toThrow(/does not exist/);

      expect(await database.piv.count({ where: { propertyId } })).toBe(0);
      expect(await database.offering.count({ where: { piv: { propertyId } } })).toBe(0);
    });
  },
);

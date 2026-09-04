import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { OpenOfferingForApprovedCaseService } from "../src/modules/offering/application/open-offering-for-approved-case.service.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";
import { PrismaOriginationRepository } from "../src/modules/origination/repository/prisma-origination.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "origination approval to offering handoff PostgreSQL integration",
  () => {
    const suffix = randomUUID();
    const accountId = `acct_${suffix}`;
    const betterAuthUserId = `auth_${suffix}`;
    const propertyId = `property_${suffix}`;
    const caseId = `case_${suffix}`;
    const revisionId = `rev_${suffix}`;
    const authPool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");
    // PgBoss's constructor eagerly validates its connection string (unlike
    // PrismaClient/pg.Pool above, which connect lazily), so it must not be
    // constructed at describe-body scope: that body runs even when skipIf
    // skips every test, and databaseUrl is undefined in that case.
    let boss: PgBoss;
    let originationRepository: PrismaOriginationRepository;
    let offeringRepository: PrismaOfferingRepository;
    let openOfferingForApprovedCase: OpenOfferingForApprovedCaseService;
    let pivId = "";
    let offeringId = "";

    beforeAll(async () => {
      boss = new PgBoss(databaseUrl ?? "");
      originationRepository = new PrismaOriginationRepository(database, boss);
      offeringRepository = new PrismaOfferingRepository(database, boss);
      openOfferingForApprovedCase = new OpenOfferingForApprovedCaseService(offeringRepository);
      await boss.start();
      await boss.createQueue("case_timers.pre_offering_open_handoff");
      await boss.createQueue("settlement.open_ipo_escrow_campaign");

      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [betterAuthUserId, "Handoff Test Applicant", `handoff-${suffix}@example.test`, true, "customer"],
      );
      await database.account.create({ data: { id: accountId, betterAuthUserId } });
      await database.property.create({
        data: {
          id: propertyId,
          countryCode: "RS",
          city: "Belgrade",
          addressLine: "Handoff Test 1",
          ownerDeclaredValueEur: "300000.00",
        },
      });
      await database.originationCase.create({
        data: {
          id: caseId,
          propertyId,
          applicantAccountId: accountId,
          stage: "submitted",
          legalExecutionEventRefs: [],
          legalDocumentRefs: [],
          appraisalDocumentRefs: [],
        },
      });
      await database.submissionRevision.create({
        data: {
          id: revisionId,
          caseId,
          revisionNumber: 1,
          submittedByAccountId: accountId,
          submissionData: {},
          reason: "initial",
        },
      });
      await database.originationCase.update({
        where: { id: caseId },
        data: { currentSubmissionRevisionId: revisionId },
      });
    }, 30_000);

    afterAll(async () => {
      await database.auditLog.deleteMany({
        where: {
          OR: [
            { resourceId: caseId },
            ...(offeringId === "" ? [] : [{ resourceId: offeringId, resourceType: "offering" }]),
          ],
        },
      });
      if (pivId !== "") {
        await database.offering.deleteMany({ where: { pivId } });
        await database.piv.deleteMany({ where: { id: pivId } });
      }
      // submission_revisions is append-only by design (AD-186's
      // "submission_revisions_append_only" trigger rejects every UPDATE and
      // DELETE unconditionally) -- and that isn't just local to that table:
      // submission_revisions.case_id -> origination_cases and
      // submission_revisions.submitted_by_account_id -> account.accounts are
      // both ON DELETE RESTRICT, and origination_cases.property_id ->
      // properties is RESTRICT too. So once beforeAll creates a revision,
      // the case, the property, and the submitting account all become
      // permanently undeletable as a direct, correct consequence of the
      // audit trail's own design -- not something to work around. This test
      // relies on its account/case/property/revision IDs already being
      // uniquely suffixed per run, so leaving them in place is safe: nothing
      // here can ever collide with a later run.
      await Promise.all([boss.stop(), database.$disconnect(), authPool.end()]);
    });

    it("durably enqueues the offering handoff in the same transaction as approval, and the job opens a browsable offering", async () => {
      const traceId = `trace_handoff_${suffix}`;
      const recorded = await originationRepository.recordFounderDecision({
        decision: "approve",
        accountId,
        caseId,
        traceId,
        founderReviewNotes: "Looks good",
        decidedAt: new Date("2026-09-01T18:00:00.000Z"),
        ipoPeriodDays: 30,
        ipoEndAt: new Date("2026-10-01T18:00:00.000Z"),
        ipoValueEur: "300000.00",
      });
      expect(recorded).toMatchObject({ caseId, stage: "pre_offering_open" });

      const enqueued = await authPool.query<{ name: string; data: { case_id: string; property_id: string; ipo_value_eur: string; trace_id: string } }>(
        "SELECT name, data FROM pgboss.job WHERE name = $1 AND data->>'case_id' = $2",
        ["case_timers.pre_offering_open_handoff", caseId],
      );
      expect(enqueued.rows).toHaveLength(1);
      expect(enqueued.rows[0]?.data).toEqual({
        case_id: caseId,
        property_id: propertyId,
        ipo_value_eur: "300000.00",
        trace_id: traceId,
      });

      const opened = await openOfferingForApprovedCase.execute(enqueued.rows[0]?.data);
      pivId = opened.pivId;
      offeringId = opened.offeringId;
      expect(await database.piv.findUnique({ where: { id: opened.pivId } })).toMatchObject({
        propertyId,
        caseId,
      });
      expect(await database.offering.findUnique({ where: { id: opened.offeringId } })).toMatchObject({
        pivId: opened.pivId,
        status: "pre_offering",
        minimumRaiseEur: expect.anything(),
        targetRaiseEur: expect.anything(),
      });

      // Replaying the same job payload (as pg-boss would on a retry) must
      // not create a second Piv/Offering for the same property.
      const replayed = await openOfferingForApprovedCase.execute(enqueued.rows[0]?.data);
      expect(replayed).toEqual(opened);
      expect(await database.piv.count({ where: { propertyId } })).toBe(1);
      expect(await database.offering.count({ where: { pivId: opened.pivId } })).toBe(1);
    }, 30_000);
  },
);

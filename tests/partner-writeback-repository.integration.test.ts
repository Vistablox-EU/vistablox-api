import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import { CaseReviewConflictError } from "../src/modules/intake/repository/intake.repository.js";
import { PrismaIntakeRepository } from "../src/modules/intake/repository/prisma-intake.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// CORE_TABLES.md: post_ipo_structuring_completed_at is "set once both
// legal_structuring_completed_at and appraisal_completed_at are set; stage
// moves post_ipo_structuring -> approved_for_final_offering in the same
// action". That rule lives inside PrismaIntakeRepository's transactions (the
// repository layer does not import the domain layer), so the fake-repository
// tests around the services cannot see it. A mutation check that flipped the
// && to || in either method left every test green; these suites close that gap
// against a real database.
describe.skipIf(databaseUrl === undefined)(
  "partner writeback and the both-complete auto-advance PostgreSQL integration (AD-248)",
  () => {
    const suffix = randomUUID();
    const applicantAccountId = `acct_pw_applicant_${suffix}`;
    const partnerAccountId = `acct_pw_partner_${suffix}`;
    const authPool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");
    // PgBoss's constructor eagerly validates its connection string, so it must
    // not be constructed at describe-body scope (the body runs even when
    // skipIf skips every test and databaseUrl is undefined).
    let boss: PgBoss;
    let repository: PrismaIntakeRepository;
    const caseIds: string[] = [];

    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute));

    async function createCase(stage = "post_ipo_structuring"): Promise<string> {
      const id = randomUUID();
      const propertyId = `property_pw_${id}`;
      const caseId = `case_pw_${id}`;
      await database.property.create({
        data: {
          id: propertyId,
          countryCode: "RS",
          city: "Belgrade",
          addressLine: "Partner Writeback Test 1",
          ownerDeclaredValueEur: "300000.00",
        },
      });
      await database.intakeCase.create({
        data: {
          id: caseId,
          propertyId,
          applicantAccountId,
          stage,
          legalExecutionEventRefs: [],
          legalDocumentRefs: [],
          appraisalDocumentRefs: [],
        },
      });
      caseIds.push(caseId);
      return caseId;
    }

    const recordLegal = (
      caseId: string,
      recordedAt: Date,
      extra: { legalDocumentRefs?: string[]; markCompleted?: boolean } = {},
    ) =>
      repository.recordLegalStructuring({
        caseId,
        actorAccountId: partnerAccountId,
        traceId: `trace_${randomUUID()}`,
        recordedAt,
        ...extra,
      });

    const recordAppraisal = (
      caseId: string,
      recordedAt: Date,
      extra: { appraisalValueOpinionEur?: string; appraisalDocumentRefs?: string[]; markCompleted?: boolean } = {},
    ) =>
      repository.recordAppraisal({
        caseId,
        actorAccountId: partnerAccountId,
        traceId: `trace_${randomUUID()}`,
        recordedAt,
        ...extra,
      });

    async function ledgerEventTypes(caseId: string): Promise<string[]> {
      const events = await database.intakeCaseEvent.findMany({
        where: {
          caseId,
          eventType: { in: ["legal_structuring_updated", "appraisal_updated", "case_approved_for_final_offering"] },
        },
        orderBy: { eventSequence: "asc" },
        select: { eventType: true },
      });
      return events.map((event) => event.eventType);
    }

    async function auditActions(caseId: string): Promise<string[]> {
      const rows = await database.auditLog.findMany({ where: { resourceId: caseId }, select: { action: true } });
      return rows.map((row) => row.action).sort();
    }

    beforeAll(async () => {
      boss = new PgBoss(databaseUrl ?? "");
      repository = new PrismaIntakeRepository(database, boss, new PrismaKycRepository(database, boss));
      await boss.start();

      for (const [accountId, label] of [
        [applicantAccountId, "applicant"],
        [partnerAccountId, "partner"],
      ] as const) {
        const authId = `auth_pw_${label}_${suffix}`;
        await authPool.query(
          'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
          [authId, `Partner Writeback ${label}`, `pw-${label}-${suffix}@example.test`, true, "customer"],
        );
        await database.account.create({ data: { id: accountId, betterAuthUserId: authId } });
      }
    }, 30_000);

    afterAll(async () => {
      // intake_case_events is append-only (trigger), and its case, the case's
      // property and the applicant account are all RESTRICT-linked to it, so
      // those rows stay behind by design; every id above is uniquely suffixed
      // per run, so nothing can collide with a later run. Only the audit rows
      // are deletable.
      await database.auditLog.deleteMany({ where: { resourceId: { in: caseIds } } });
      await Promise.all([database.$disconnect(), authPool.end(), boss.stop({ graceful: false })]);
    });

    it("keeps the case at post_ipo_structuring until both sides complete, then advances it (legal first)", async () => {
      const caseId = await createCase();

      const afterLegal = await recordLegal(caseId, at(1), {
        legalDocumentRefs: ["documents/deed.pdf"],
        markCompleted: true,
      });
      expect(afterLegal).toMatchObject({
        stage: "post_ipo_structuring",
        legalDocumentRefs: ["documents/deed.pdf"],
        legalStructuringCompletedAt: at(1),
        appraisalCompletedAt: null,
        postIpoStructuringCompletedAt: null,
      });
      const midway = await database.intakeCase.findUniqueOrThrow({ where: { id: caseId } });
      expect(midway.stage).toBe("post_ipo_structuring");
      expect(midway.approvedForFinalOfferingAt).toBeNull();
      expect(await ledgerEventTypes(caseId)).toEqual(["legal_structuring_updated"]);
      expect(await auditActions(caseId)).toEqual(["intake.case_legal_structuring_recorded"]);

      const afterAppraisal = await recordAppraisal(caseId, at(2), {
        appraisalValueOpinionEur: "520000.00",
        appraisalDocumentRefs: ["documents/valuation.pdf"],
        markCompleted: true,
      });
      expect(afterAppraisal).toMatchObject({
        stage: "approved_for_final_offering",
        legalStructuringCompletedAt: at(1),
        appraisalCompletedAt: at(2),
        appraisalValueOpinionEur: "520000.00",
        postIpoStructuringCompletedAt: at(2),
      });
      const done = await database.intakeCase.findUniqueOrThrow({ where: { id: caseId } });
      expect(done.stage).toBe("approved_for_final_offering");
      expect(done.approvedForFinalOfferingAt).toEqual(at(2));

      expect(await ledgerEventTypes(caseId)).toEqual(["legal_structuring_updated", "case_approved_for_final_offering"]);
      const transition = await database.intakeCaseEvent.findFirstOrThrow({
        where: { caseId, eventType: "case_approved_for_final_offering" },
      });
      expect(transition).toMatchObject({
        fromStage: "post_ipo_structuring",
        toStage: "approved_for_final_offering",
        actorType: "partner",
        actorAccountId: partnerAccountId,
      });
      expect(await auditActions(caseId)).toEqual([
        "intake.case_appraisal_recorded",
        "intake.case_approved_for_final_offering",
        "intake.case_legal_structuring_recorded",
      ]);
    });

    it("advances the case when the legal side is the one that completes second (appraisal first)", async () => {
      const caseId = await createCase();

      const afterAppraisal = await recordAppraisal(caseId, at(1), {
        appraisalValueOpinionEur: "410000.00",
        markCompleted: true,
      });
      expect(afterAppraisal).toMatchObject({ stage: "post_ipo_structuring", appraisalCompletedAt: at(1) });

      const afterLegal = await recordLegal(caseId, at(2), { markCompleted: true });
      expect(afterLegal).toMatchObject({
        stage: "approved_for_final_offering",
        legalStructuringCompletedAt: at(2),
        appraisalCompletedAt: at(1),
        postIpoStructuringCompletedAt: at(2),
      });
      expect(await ledgerEventTypes(caseId)).toEqual(["appraisal_updated", "case_approved_for_final_offering"]);
    });

    it("does not advance on document uploads alone, only once the second side is explicitly marked complete", async () => {
      const caseId = await createCase();
      await recordAppraisal(caseId, at(1), { appraisalValueOpinionEur: "300000.00", markCompleted: true });

      const refsOnly = await recordLegal(caseId, at(2), { legalDocumentRefs: ["documents/draft-deed.pdf"] });
      expect(refsOnly).toMatchObject({
        stage: "post_ipo_structuring",
        legalDocumentRefs: ["documents/draft-deed.pdf"],
        legalStructuringCompletedAt: null,
        postIpoStructuringCompletedAt: null,
      });

      const completed = await recordLegal(caseId, at(3), { markCompleted: true });
      expect(completed).toMatchObject({
        stage: "approved_for_final_offering",
        // refs from the earlier call are kept when a later call sends none
        legalDocumentRefs: ["documents/draft-deed.pdf"],
        legalStructuringCompletedAt: at(3),
      });
    });

    it("does not advance on an appraisal value or documents alone, only once it is explicitly marked complete", async () => {
      const caseId = await createCase();
      await recordLegal(caseId, at(1), { markCompleted: true });

      const valueOnly = await recordAppraisal(caseId, at(2), {
        appraisalValueOpinionEur: "310000.00",
        appraisalDocumentRefs: ["documents/draft-valuation.pdf"],
      });
      expect(valueOnly).toMatchObject({
        stage: "post_ipo_structuring",
        appraisalValueOpinionEur: "310000.00",
        appraisalCompletedAt: null,
        postIpoStructuringCompletedAt: null,
      });

      const completed = await recordAppraisal(caseId, at(3), { markCompleted: true });
      expect(completed).toMatchObject({
        stage: "approved_for_final_offering",
        // value and refs from the earlier call are kept when a later call sends none
        appraisalValueOpinionEur: "310000.00",
        appraisalDocumentRefs: ["documents/draft-valuation.pdf"],
        appraisalCompletedAt: at(3),
        postIpoStructuringCompletedAt: at(3),
      });
    });

    it("never refreshes an existing completed_at on a later call", async () => {
      const caseId = await createCase();
      await recordLegal(caseId, at(1), { legalDocumentRefs: ["documents/v1.pdf"], markCompleted: true });

      const later = await recordLegal(caseId, at(9), { legalDocumentRefs: ["documents/v2.pdf"], markCompleted: true });

      expect(later).toMatchObject({
        stage: "post_ipo_structuring",
        legalDocumentRefs: ["documents/v2.pdf"],
        legalStructuringCompletedAt: at(1),
      });
    });

    it("never refreshes an existing appraisal completed_at on a later call", async () => {
      const caseId = await createCase();
      await recordAppraisal(caseId, at(1), { appraisalValueOpinionEur: "300000.00", markCompleted: true });

      const later = await recordAppraisal(caseId, at(9), { appraisalValueOpinionEur: "305000.00", markCompleted: true });

      expect(later).toMatchObject({
        stage: "post_ipo_structuring",
        appraisalValueOpinionEur: "305000.00",
        appraisalCompletedAt: at(1),
      });
    });

    it("rejects every further partner writeback once the case has advanced, leaving the record untouched", async () => {
      const caseId = await createCase();
      await recordLegal(caseId, at(1), { legalDocumentRefs: ["documents/final.pdf"], markCompleted: true });
      await recordAppraisal(caseId, at(2), { appraisalValueOpinionEur: "500000.00", markCompleted: true });
      const eventsBefore = await ledgerEventTypes(caseId);

      await expect(recordLegal(caseId, at(3), { legalDocumentRefs: ["documents/late.pdf"] })).rejects.toBeInstanceOf(
        CaseReviewConflictError,
      );
      await expect(recordAppraisal(caseId, at(4), { appraisalValueOpinionEur: "1.00" })).rejects.toMatchObject({
        currentStage: "approved_for_final_offering",
      });

      const row = await database.intakeCase.findUniqueOrThrow({ where: { id: caseId } });
      expect(row.legalDocumentRefs).toEqual(["documents/final.pdf"]);
      expect(row.appraisalValueOpinionEur?.toFixed(2)).toBe("500000.00");
      expect(await ledgerEventTypes(caseId)).toEqual(eventsBefore);
    });

    it("rejects writeback on a case that has not reached post_ipo_structuring, and returns null for an unknown case", async () => {
      const earlyCaseId = await createCase("pre_offering_open");

      await expect(recordLegal(earlyCaseId, at(1), { markCompleted: true })).rejects.toMatchObject({
        currentStage: "pre_offering_open",
      });
      await expect(recordAppraisal(earlyCaseId, at(1), { markCompleted: true })).rejects.toBeInstanceOf(
        CaseReviewConflictError,
      );
      expect((await database.intakeCase.findUniqueOrThrow({ where: { id: earlyCaseId } })).stage).toBe(
        "pre_offering_open",
      );

      await expect(recordLegal(`case_missing_${suffix}`, at(1), { markCompleted: true })).resolves.toBeNull();
      await expect(recordAppraisal(`case_missing_${suffix}`, at(1), { markCompleted: true })).resolves.toBeNull();
    });

    // Resolves once `count` sessions are parked on a row lock over intake_cases.
    async function waitForLockWaiters(count: number): Promise<void> {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const { rows } = await authPool.query<{ waiting: string }>(
          `SELECT count(*) AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%intake_cases%'`,
        );
        if (Number(rows[0]?.waiting ?? 0) >= count) return;
        if (Date.now() > deadline) throw new Error(`fewer than ${count} writebacks were waiting on the case row lock`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    it("advances exactly once when both partners complete at the same moment", async () => {
      const caseId = await createCase();

      // Hold the case row from a third connection so both writebacks are in
      // flight before either can write. Run back to back they would not
      // overlap at all, and the test would pass without any locking. With the
      // row lock taken inside each transaction, both queue on it and the
      // second to run sees the first's completion; without it, both would
      // read the other side as incomplete and the case would stay stuck.
      const blocker = await authPool.connect();
      let results;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT case_id FROM intake.intake_cases WHERE case_id = $1 FOR UPDATE", [caseId]);
        const pending = Promise.all([
          recordLegal(caseId, at(1), { markCompleted: true }),
          recordAppraisal(caseId, at(1), { appraisalValueOpinionEur: "350000.00", markCompleted: true }),
        ]);
        try {
          await waitForLockWaiters(2);
        } finally {
          await blocker.query("COMMIT");
        }
        results = await pending;
      } finally {
        blocker.release();
      }
      const [legal, appraisal] = results;

      // Whichever transaction took the row lock second saw the other's
      // completion and performed the single transition.
      expect([legal?.stage, appraisal?.stage].sort()).toEqual(["approved_for_final_offering", "post_ipo_structuring"]);
      const row = await database.intakeCase.findUniqueOrThrow({ where: { id: caseId } });
      expect(row.stage).toBe("approved_for_final_offering");
      expect(row.legalStructuringCompletedAt).not.toBeNull();
      expect(row.appraisalCompletedAt).not.toBeNull();
      const transitions = (await ledgerEventTypes(caseId)).filter((type) => type === "case_approved_for_final_offering");
      expect(transitions).toHaveLength(1);
      expect(
        (await auditActions(caseId)).filter((action) => action === "intake.case_approved_for_final_offering"),
      ).toHaveLength(1);
    });
  },
);

import { randomUUID } from "node:crypto";

import express, { type RequestHandler } from "express";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import { createIntakeOperationsRouter } from "../src/modules/intake/api/intake-operations.router.js";
import {
  ApproveIntakeReversalService,
  GetIntakeReversalOperationService,
  GetIntakeReversalPreviewService,
  RequestIntakeReversalService,
} from "../src/modules/intake/application/intake-reversal.service.js";
import { appendIntakeCaseEvent } from "../src/modules/intake/repository/intake-case-event.repository.js";
import { CaseReviewConflictError } from "../src/modules/intake/repository/intake.repository.js";
import { PrismaIntakeRepository } from "../src/modules/intake/repository/prisma-intake.repository.js";
import { OpenOfferingForApprovedCaseService } from "../src/modules/offering/application/open-offering-for-approved-case.service.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

type FixtureStage =
  | "submitted"
  | "waiting_on_applicant"
  | "pre_offering_open"
  | "post_ipo_structuring"
  | "approved_for_final_offering";

const decidedAt = new Date("2026-09-01T10:00:00.000Z");
const now = new Date("2026-10-01T09:00:00.000Z");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const sleep = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));

// Tells whether a promise is still pending after a grace period, without
// letting a rejection escape as unhandled.
async function stillPendingAfter(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  const outcome = await Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    sleep(milliseconds).then(() => "pending"),
  ]);
  return outcome === "pending";
}

describe.skipIf(databaseUrl === undefined)("intake case reversal PostgreSQL integration", () => {
  const suffix = randomUUID();
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  // PgBoss validates its connection string eagerly, so it cannot be built at
  // describe scope: this body runs even when skipIf skips every test.
  let boss: PgBoss;
  let intakeRepository: PrismaIntakeRepository;
  let offeringRepository: PrismaOfferingRepository;
  let requestService: RequestIntakeReversalService;
  let approveService: ApproveIntakeReversalService;
  let previewService: GetIntakeReversalPreviewService;

  const requesterId = `acct_rev_requester_${suffix}`;
  const approverId = `acct_rev_approver_${suffix}`;
  const applicantId = `acct_rev_applicant_${suffix}`;
  const investorId = `acct_rev_investor_${suffix}`;
  let counter = 0;
  const uid = (prefix: string) => `${prefix}_${suffix}_${++counter}`;

  beforeAll(async () => {
    boss = new PgBoss(databaseUrl ?? "");
    const kycRepository = new PrismaKycRepository(database, boss);
    intakeRepository = new PrismaIntakeRepository(database, boss, kycRepository);
    offeringRepository = new PrismaOfferingRepository(database, boss, kycRepository);
    requestService = new RequestIntakeReversalService(intakeRepository, () => now);
    approveService = new ApproveIntakeReversalService(intakeRepository, () => now);
    previewService = new GetIntakeReversalPreviewService(intakeRepository);

    for (const accountId of [requesterId, approverId, applicantId, investorId]) {
      const authId = `auth_${accountId}`;
      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [authId, "Reversal Test User", `${accountId}@example.test`, true, "customer"],
      );
      await database.account.create({ data: { id: accountId, betterAuthUserId: authId } });
    }
  }, 30_000);

  afterAll(async () => {
    // intake_case_events is append-only (trigger) and its parents are RESTRICT
    // FKs, so the fixture cases are intentionally left behind; every id is
    // uniquely suffixed, which keeps later runs from colliding.
    await Promise.all([database.$disconnect(), authPool.end(), boss.stop({ graceful: false })]);
  });

  interface Fixture {
    caseId: string;
    offeringId: string | null;
    // event id of the transition into each stage the fixture walked through
    transitions: Partial<Record<string, string>>;
  }

  async function appendFixtureEvents(
    caseId: string,
    events: Array<{ key: string; type: string; from?: string; to?: string }>,
  ): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    for (const event of events) {
      ids[event.key] = await database.$transaction((transaction) =>
        appendIntakeCaseEvent(transaction, {
          caseId,
          eventKey: `case:${caseId}:fixture:${event.key}`,
          eventType: event.type,
          actorType: "staff",
          actorAccountId: requesterId,
          fromStage: event.from ?? null,
          toStage: event.to ?? null,
          occurredAt: decidedAt,
        }),
      );
    }
    return ids;
  }

  // Builds a case at `stage` with the lifecycle ledger a real run would have
  // left, and (from pre_offering_open on) a PIV with one offering.
  async function createCase(stage: FixtureStage): Promise<Fixture> {
    const caseId = uid("case_rev");
    const propertyId = uid("property_rev");
    await database.property.create({
      data: {
        id: propertyId,
        countryCode: "RS",
        city: "Belgrade",
        addressLine: "Reversal Test 1",
        ownerDeclaredValueEur: "300000.00",
      },
    });
    const pastApproval = stage === "pre_offering_open" || stage === "post_ipo_structuring" || stage === "approved_for_final_offering";
    await database.intakeCase.create({
      data: {
        id: caseId,
        propertyId,
        applicantAccountId: applicantId,
        stage,
        legalExecutionEventRefs: [],
        legalDocumentRefs: [],
        appraisalDocumentRefs: [],
        ...(pastApproval
          ? {
              approvedAt: decidedAt,
              ipoPeriodDays: 30,
              ipoEndAt: new Date("2026-10-01T10:00:00.000Z"),
              ipoValueEur: "300000.00",
              exclusivityCommencedAt: decidedAt,
            }
          : {}),
        ...(stage === "post_ipo_structuring" || stage === "approved_for_final_offering"
          ? { postIpoStructuringCompletedAt: decidedAt }
          : {}),
        ...(stage === "approved_for_final_offering" ? { approvedForFinalOfferingAt: decidedAt } : {}),
      },
    });

    const walked: Array<{ key: string; type: string; from?: string; to?: string }> = [
      { key: "created", type: "case_created" },
      { key: "submitted", type: "case_submitted", from: "draft", to: "submitted" },
    ];
    if (stage === "waiting_on_applicant") {
      walked.push({ key: "waiting_on_applicant", type: "case_information_requested", from: "submitted", to: "waiting_on_applicant" });
      await database.informationRequest.create({
        data: {
          id: uid("inforeq_rev"),
          caseId,
          requestingWorkstream: "intake",
          proposedByAccountId: requesterId,
          status: "published",
          publishedByAccountId: requesterId,
          publishedAt: decidedAt,
          dueAt: new Date("2026-10-15T10:00:00.000Z"),
          requestBody: "Please send the missing extract.",
        },
      });
    }
    if (pastApproval) walked.push({ key: "pre_offering_open", type: "founder_decision_recorded", from: "submitted", to: "pre_offering_open" });
    if (stage === "post_ipo_structuring" || stage === "approved_for_final_offering") {
      walked.push({ key: "post_ipo_structuring", type: "case_post_ipo_structuring_started", from: "pre_offering_open", to: "post_ipo_structuring" });
    }
    if (stage === "approved_for_final_offering") {
      walked.push({ key: "approved_for_final_offering", type: "case_approved_for_final_offering", from: "post_ipo_structuring", to: "approved_for_final_offering" });
    }
    const transitions = await appendFixtureEvents(caseId, walked);

    let offeringId: string | null = null;
    if (pastApproval) {
      const pivId = uid("piv_rev");
      // No token id: nothing here uses one, and these PIVs are left behind, so
      // taking values from the shared sequence would collide with tests that
      // insert fixed token ids.
      await database.piv.create({ data: { id: pivId, propertyId, caseId } });
      offeringId = uid("offering_rev");
      await database.offering.create({
        data: { id: offeringId, pivId, minimumRaiseEur: "300000.00", targetRaiseEur: "300000.00" },
      });
    }
    return { caseId, offeringId, transitions };
  }

  async function addReservation(
    offeringId: string,
    options: { stage?: string; capitalState?: string } = {},
  ): Promise<string> {
    const reservationId = uid("reservation_rev");
    await database.reservation.create({
      data: {
        id: reservationId,
        offeringId,
        accountId: investorId,
        amountEur: "1000.00",
        reservationStage: options.stage ?? "initiated",
      },
    });
    await database.moneyEvent.create({
      data: {
        id: uid("money_event_rev"),
        reservationId,
        provider: "coinbase_cdp",
        capitalState: options.capitalState ?? "initiated",
        amountEur: "1000.00",
      },
    });
    return reservationId;
  }

  // An information request that is no longer open to the applicant (or never
  // was), as the history of a case that went through a request-for-information.
  async function addHistoricInformationRequest(caseId: string, status: "proposed" | "answered" | "withdrawn" | "expired") {
    const resolved = { resolvedAt: decidedAt };
    let resolution: Record<string, unknown> = {};
    if (status === "answered") {
      const revisionId = uid("revision_rev");
      await database.submissionRevision.create({
        data: { id: revisionId, caseId, revisionNumber: 100 + ++counter, submittedByAccountId: applicantId, submissionData: {}, reason: "resubmission_after_rfi" },
      });
      resolution = { ...resolved, resolutionType: "resubmitted", resolvingRevisionId: revisionId };
    } else if (status === "withdrawn" || status === "expired") {
      resolution = { ...resolved, resolutionType: status };
    }
    await database.informationRequest.create({
      data: {
        id: uid("inforeq_rev"),
        caseId,
        requestingWorkstream: "intake",
        proposedByAccountId: requesterId,
        status,
        ...(status === "proposed" ? {} : { publishedByAccountId: requesterId, publishedAt: decidedAt, dueAt: new Date("2026-10-15T10:00:00.000Z") }),
        requestBody: `Earlier request, now ${status}.`,
        ...resolution,
      },
    });
  }

  const readCase = (caseId: string) => database.intakeCase.findUniqueOrThrow({ where: { id: caseId } });
  const readOperation = (operationId: string) =>
    database.intakeCaseReversalOperation.findUniqueOrThrow({ where: { id: operationId } });
  const readEvents = (caseId: string) =>
    database.intakeCaseEvent.findMany({ where: { caseId }, orderBy: { eventSequence: "asc" } });
  const readAudit = (caseId: string, action: string) =>
    database.auditLog.findMany({ where: { resourceId: caseId, action }, orderBy: { createdAt: "asc" } });

  async function requestReversal(
    fixture: Fixture,
    command: string,
    overrides: Partial<Parameters<RequestIntakeReversalService["execute"]>[0]> = {},
  ) {
    const current = await readCase(fixture.caseId);
    return requestService.execute({
      caseId: fixture.caseId,
      command,
      accountId: requesterId,
      traceId: uid("trace_rev"),
      idempotencyKey: uid("key"),
      expectedStage: current.stage,
      expectedWorkflowEventSequence: current.workflowEventSequence,
      reasonCode: "operator_input_error",
      reason: "Entered against the wrong case",
      ...overrides,
    });
  }

  const approve = (fixture: Fixture, operationId: string, accountId = approverId) =>
    approveService.execute({ caseId: fixture.caseId, operationId, accountId, traceId: uid("trace_rev") });

  // Records an unrelated lifecycle event, the way any other staff or
  // applicant action would, so the case's workflow sequence moves.
  async function bumpSequence(caseId: string) {
    await appendFixtureEvents(caseId, [{ key: uid("bump"), type: "case_evidence_reviewed" }]);
  }

  async function requestReversalOperationRow(fixture: Fixture) {
    const current = await readCase(fixture.caseId);
    return intakeRepository.createReversalOperation({
      caseId: fixture.caseId,
      command: "return_to_draft",
      fromStage: "submitted",
      toStage: "draft",
      status: "requested",
      reasonCode: "operator_input_error",
      reason: "created directly for a repository-level test",
      requestedByAccountId: requesterId,
      expectedStage: current.stage,
      expectedWorkflowEventSequence: current.workflowEventSequence,
      reversalOfEventId: fixture.transitions.submitted ?? null,
      idempotencyKey: uid("key"),
      traceId: uid("trace"),
    });
  }

  async function snapshotCorrectionsInProgress(caseId: string) {
    return (await intakeRepository.getIntakeReversalSnapshot(caseId))?.correctionInProgress;
  }

  describe("getIntakeReversalSnapshot", () => {
    it("returns null for an unknown case", async () => {
      await expect(intakeRepository.getIntakeReversalSnapshot(`missing_${suffix}`)).resolves.toBeNull();
    });

    it("reports the stage, sequence and the latest stage transition of a submitted case", async () => {
      const fixture = await createCase("submitted");
      const snapshot = await intakeRepository.getIntakeReversalSnapshot(fixture.caseId);
      expect(snapshot).toEqual({
        caseId: fixture.caseId,
        stage: "submitted",
        workflowEventSequence: 2,
        latestTransition: { eventId: fixture.transitions.submitted, fromStage: "draft", toStage: "submitted" },
        latestTransitionReversed: false,
        activeInformationRequest: false,
        offering: null,
        legalExecutionCompleted: false,
        appraisalCompleted: false,
        correctionInProgress: false,
      });
    });

    it("ignores events that are not stage transitions when picking the latest transition", async () => {
      const fixture = await createCase("submitted");
      await bumpSequence(fixture.caseId);
      const snapshot = await intakeRepository.getIntakeReversalSnapshot(fixture.caseId);
      expect(snapshot?.workflowEventSequence).toBe(3);
      expect(snapshot?.latestTransition?.eventId).toBe(fixture.transitions.submitted);
    });

    it("flags a published information request", async () => {
      const fixture = await createCase("waiting_on_applicant");
      const snapshot = await intakeRepository.getIntakeReversalSnapshot(fixture.caseId);
      expect(snapshot).toMatchObject({ stage: "waiting_on_applicant", activeInformationRequest: true });
    });

    it("only counts an information request that is still published", async () => {
      const fixture = await createCase("submitted");
      for (const status of ["proposed", "answered", "withdrawn", "expired"] as const) {
        await addHistoricInformationRequest(fixture.caseId, status);
      }
      expect((await intakeRepository.getIntakeReversalSnapshot(fixture.caseId))?.activeInformationRequest).toBe(false);

      await database.informationRequest.create({
        data: {
          id: uid("inforeq_rev"),
          caseId: fixture.caseId,
          requestingWorkstream: "intake",
          proposedByAccountId: requesterId,
          status: "published",
          publishedByAccountId: requesterId,
          publishedAt: decidedAt,
          dueAt: new Date("2026-10-15T10:00:00.000Z"),
          requestBody: "Now there is an open one.",
        },
      });
      expect((await intakeRepository.getIntakeReversalSnapshot(fixture.caseId))?.activeInformationRequest).toBe(true);
    });

    it("counts the offering's reservations, funding, disclosure pack and finalized state", async () => {
      const fixture = await createCase("pre_offering_open");
      const offeringId = fixture.offeringId!;
      await addReservation(offeringId, { stage: "initiated", capitalState: "initiated" });
      await addReservation(offeringId, { stage: "initiated", capitalState: "eurc_reserved" });
      await addReservation(offeringId, { stage: "awaiting_reconfirmation", capitalState: "reconfirmation_pending" });
      await addReservation(offeringId, { stage: "finalized", capitalState: "eurc_finalized" });
      await addReservation(offeringId, { stage: "cancelled", capitalState: "initiated" });
      await addReservation(offeringId, { stage: "lapsed", capitalState: "initiated" });
      await database.disclosurePack.create({
        data: { id: uid("pack_rev"), offeringId, version: 1, publishedAt: decidedAt },
      });
      await database.offering.update({ where: { id: offeringId }, data: { finalOfferingPublishedAt: decidedAt } });

      const snapshot = await intakeRepository.getIntakeReversalSnapshot(fixture.caseId);

      expect(snapshot?.offering).toEqual({
        offeringId,
        status: "pre_offering",
        finalOfferingPublishedAt: decidedAt,
        // cancelled and lapsed reservations no longer hold anything
        reservationCount: 4,
        // the latest money event decides: reserved, reconfirmation pending and finalized are funded
        fundedReservationCount: 3,
        disclosurePackPublished: true,
        reconfirmationOpen: true,
        finalizedReservationCount: 1,
      });
    });

    it("uses each reservation's latest money event, not an earlier one", async () => {
      const fixture = await createCase("pre_offering_open");
      const reservationId = await addReservation(fixture.offeringId!, { capitalState: "eurc_reserved" });
      await database.moneyEvent.create({
        data: {
          id: uid("money_event_rev"),
          reservationId,
          provider: "coinbase_cdp",
          capitalState: "refunded",
          amountEur: "1000.00",
          recordedAt: new Date(Date.now() + 60_000),
        },
      });
      const snapshot = await intakeRepository.getIntakeReversalSnapshot(fixture.caseId);
      expect(snapshot?.offering).toMatchObject({ reservationCount: 1, fundedReservationCount: 0 });
    });

    it("reports legal execution and appraisal completion", async () => {
      const fixture = await createCase("post_ipo_structuring");
      await database.intakeCase.update({
        where: { id: fixture.caseId },
        data: { legalExecutionEventRefs: ["exec_1"], appraisalCompletedAt: decidedAt },
      });
      const snapshot = await intakeRepository.getIntakeReversalSnapshot(fixture.caseId);
      expect(snapshot).toMatchObject({ legalExecutionCompleted: true, appraisalCompleted: true });
    });

    it.each([
      ["requested", true],
      ["pending_approval", true],
      ["approved", true],
      ["executing", true],
      ["completed", false],
      ["failed", false],
      ["cancelled", false],
    ] as const)("treats a %s operation as correction in progress: %s", async (status, inProgress) => {
      const fixture = await createCase("submitted");
      await database.intakeCaseReversalOperation.create({
        data: {
          id: uid("rev_fixture"),
          caseId: fixture.caseId,
          command: "return_to_draft",
          fromStage: "submitted",
          toStage: "draft",
          status,
          reasonCode: "operator_input_error",
          reason: "fixture",
          requestedByAccountId: requesterId,
          expectedStage: "submitted",
          expectedWorkflowEventSequence: 3,
          idempotencyKey: uid("key"),
          traceId: uid("trace"),
        },
      });
      await expect(snapshotCorrectionsInProgress(fixture.caseId)).resolves.toBe(inProgress);
    });
  });

  describe("return_to_draft (single-person, synchronous)", () => {
    it("rewinds the case to draft, completes the operation and leaves the full audit trail", async () => {
      const fixture = await createCase("submitted");

      const result = await requestReversal(fixture, "return_to_draft", { reason: "Wrong case selected" });

      expect(result.data).toMatchObject({
        case_id: fixture.caseId,
        command: "return_to_draft",
        from_stage: "submitted",
        to_stage: "draft",
        status: "completed",
        requested_by_account_id: requesterId,
        approved_by_account_id: null,
        reversal_of_event_id: fixture.transitions.submitted,
        completed_at: now.toISOString(),
        failed_at: null,
      });

      expect(await readCase(fixture.caseId)).toMatchObject({ stage: "draft", workflowEventSequence: 4 });
      const operation = await readOperation(result.data.operation_id);
      expect(operation).toMatchObject({
        status: "completed",
        startedAt: now,
        completedAt: now,
        reason: "Wrong case selected",
        reasonCode: "operator_input_error",
        // the stored expectation already includes the request's own event
        expectedStage: "submitted",
        expectedWorkflowEventSequence: 3,
      });

      const events = await readEvents(fixture.caseId);
      const [requested, reverted] = events.slice(-2);
      expect(requested).toMatchObject({
        eventType: "correction_requested",
        actorAccountId: requesterId,
        relatedResourceType: "intake_case_reversal_operation",
        relatedResourceId: operation.id,
        fromStage: null,
        toStage: null,
        eventSequence: 3,
      });
      expect(reverted).toMatchObject({
        eventType: "case_stage_reverted",
        actorAccountId: requesterId,
        fromStage: "submitted",
        toStage: "draft",
        reversalOfEventId: fixture.transitions.submitted,
        relatedResourceId: operation.id,
        eventSequence: 4,
      });

      expect(await readAudit(fixture.caseId, "intake.correction_requested")).toHaveLength(1);
      const [executedAudit] = await readAudit(fixture.caseId, "intake.return_to_draft");
      expect(executedAudit).toMatchObject({
        actorAccountId: requesterId,
        resourceType: "intake_case",
        changes: {
          operation_id: operation.id,
          from_stage: "submitted",
          to_stage: "draft",
          reason_code: "operator_input_error",
          reason: "Wrong case selected",
        },
      });
    });

    it("still offers and runs it for a case whose earlier information requests were answered, withdrawn or expired", async () => {
      const fixture = await createCase("submitted");
      for (const status of ["answered", "withdrawn", "expired"] as const) {
        await addHistoricInformationRequest(fixture.caseId, status);
      }

      const preview = await previewService.execute(fixture.caseId);
      expect(preview.data.actions.map((action) => action.action)).toEqual(["return_to_draft"]);
      const result = await requestReversal(fixture, "return_to_draft");

      expect(result.data.status).toBe("completed");
      expect((await readCase(fixture.caseId)).stage).toBe("draft");
    });

    it("no longer offers the same correction once it has run", async () => {
      const fixture = await createCase("submitted");
      await requestReversal(fixture, "return_to_draft");
      const preview = await previewService.execute(fixture.caseId);
      expect(preview.data).toMatchObject({ stage: "draft", available: false, correction_in_progress: false });
    });
  });

  describe("reopen_pre_offering (two-person)", () => {
    it("parks the request as pending approval and changes nothing but the ledger", async () => {
      const fixture = await createCase("pre_offering_open");
      const before = await readCase(fixture.caseId);

      const result = await requestReversal(fixture, "reopen_pre_offering");

      expect(result.data).toMatchObject({ status: "pending_approval", completed_at: null, approved_by_account_id: null });
      const after = await readCase(fixture.caseId);
      expect(after).toMatchObject({
        stage: "pre_offering_open",
        approvedAt: before.approvedAt,
        ipoEndAt: before.ipoEndAt,
        workflowEventSequence: before.workflowEventSequence + 1,
      });
      expect((await database.offering.findUniqueOrThrow({ where: { id: fixture.offeringId! } })).status).toBe("pre_offering");
      expect(await readAudit(fixture.caseId, "intake.correction_requested")).toHaveLength(1);
      expect(await readAudit(fixture.caseId, "intake.reopen_pre_offering")).toHaveLength(0);
      await expect(snapshotCorrectionsInProgress(fixture.caseId)).resolves.toBe(true);
    });

    it("lets a second person approve it, which closes the offering and clears the approval", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await requestReversal(fixture, "reopen_pre_offering");

      const approved = await approve(fixture, requested.data.operation_id);

      expect(approved.data).toMatchObject({
        status: "completed",
        requested_by_account_id: requesterId,
        approved_by_account_id: approverId,
        from_stage: "pre_offering_open",
        to_stage: "submitted",
        reversal_of_event_id: fixture.transitions.pre_offering_open,
      });
      expect(await readCase(fixture.caseId)).toMatchObject({
        stage: "submitted",
        approvedAt: null,
        ipoEndAt: null,
        ipoValueEur: null,
        updatedAt: now,
      });
      expect((await database.offering.findUniqueOrThrow({ where: { id: fixture.offeringId! } })).status).toBe("closed");

      const operation = await readOperation(requested.data.operation_id);
      expect(operation).toMatchObject({ status: "completed", approvedByAccountId: approverId, approvedAt: now, completedAt: now });

      const [executedAudit] = await readAudit(fixture.caseId, "intake.reopen_pre_offering");
      expect(executedAudit).toMatchObject({ actorAccountId: approverId });
      const reverted = (await readEvents(fixture.caseId)).at(-1);
      expect(reverted).toMatchObject({
        eventType: "case_stage_reverted",
        actorAccountId: approverId,
        fromStage: "pre_offering_open",
        toStage: "submitted",
        reversalOfEventId: fixture.transitions.pre_offering_open,
      });
    });

    it("refuses to let the requester approve their own request, and leaves it pending", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await requestReversal(fixture, "reopen_pre_offering");

      await expect(approve(fixture, requested.data.operation_id, requesterId)).rejects.toMatchObject({
        status: 409,
        code: "intake.reversal_conflict",
      });

      expect(await readOperation(requested.data.operation_id)).toMatchObject({ status: "pending_approval", approvedByAccountId: null });
      expect((await readCase(fixture.caseId)).stage).toBe("pre_offering_open");
      expect((await database.offering.findUniqueOrThrow({ where: { id: fixture.offeringId! } })).status).toBe("pre_offering");
      // a second person can still approve it afterwards
      expect((await approve(fixture, requested.data.operation_id)).data.status).toBe("completed");
    });

    it("refuses a second approval of an operation that already ran", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await requestReversal(fixture, "reopen_pre_offering");
      await approve(fixture, requested.data.operation_id);

      await expect(approve(fixture, requested.data.operation_id, requesterId)).rejects.toMatchObject({ status: 409 });
      await expect(approve(fixture, requested.data.operation_id)).rejects.toMatchObject({ status: 409 });
      expect(await readAudit(fixture.caseId, "intake.reopen_pre_offering")).toHaveLength(1);
    });

    it("reports a missing operation, or one that belongs to another case, as not found", async () => {
      const fixture = await createCase("pre_offering_open");
      const other = await createCase("pre_offering_open");
      const requested = await requestReversal(fixture, "reopen_pre_offering");

      await expect(approve(fixture, `rev_missing_${suffix}`)).rejects.toMatchObject({
        status: 404,
        code: "intake.reversal_operation_not_found",
      });
      await expect(approve(other, requested.data.operation_id)).rejects.toMatchObject({ status: 404 });
      expect(await readOperation(requested.data.operation_id)).toMatchObject({ status: "pending_approval" });
    });

    it("cannot approve a single-person operation, which is already running on its own", async () => {
      const fixture = await createCase("submitted");
      const done = await requestReversal(fixture, "return_to_draft");
      await expect(approve(fixture, done.data.operation_id)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("reopen_structuring and reopen_final_offering_review (two-person)", () => {
    it("reopen_structuring sends the case back to the IPO workflow and clears the structuring completion", async () => {
      const fixture = await createCase("post_ipo_structuring");
      const requested = await requestReversal(fixture, "reopen_structuring");
      expect(requested.data.status).toBe("pending_approval");

      const approved = await approve(fixture, requested.data.operation_id);

      expect(approved.data).toMatchObject({ status: "completed", from_stage: "post_ipo_structuring", to_stage: "pre_offering_open" });
      expect(await readCase(fixture.caseId)).toMatchObject({
        stage: "pre_offering_open",
        postIpoStructuringCompletedAt: null,
        // the original approval and IPO terms are left alone
        approvedAt: decidedAt,
        ipoValueEur: expect.anything(),
      });
      // reopening structuring does not touch the offering
      expect((await database.offering.findUniqueOrThrow({ where: { id: fixture.offeringId! } })).status).toBe("pre_offering");
      expect((await readEvents(fixture.caseId)).at(-1)).toMatchObject({
        eventType: "case_stage_reverted",
        reversalOfEventId: fixture.transitions.post_ipo_structuring,
      });
    });

    it("reopen_final_offering_review sends the case back to post-IPO structuring and clears both completions", async () => {
      const fixture = await createCase("approved_for_final_offering");
      const requested = await requestReversal(fixture, "reopen_final_offering_review");
      const approved = await approve(fixture, requested.data.operation_id);

      expect(approved.data).toMatchObject({
        status: "completed",
        from_stage: "approved_for_final_offering",
        to_stage: "post_ipo_structuring",
      });
      expect(await readCase(fixture.caseId)).toMatchObject({
        stage: "post_ipo_structuring",
        approvedForFinalOfferingAt: null,
        postIpoStructuringCompletedAt: null,
      });
      expect((await readEvents(fixture.caseId)).at(-1)).toMatchObject({
        reversalOfEventId: fixture.transitions.approved_for_final_offering,
      });
    });
  });

  describe("request-time guards", () => {
    it("rejects a stale workflow sequence with 409 and writes nothing", async () => {
      const fixture = await createCase("submitted");
      const before = await readCase(fixture.caseId);

      await expect(
        requestReversal(fixture, "return_to_draft", { expectedWorkflowEventSequence: before.workflowEventSequence - 1 }),
      ).rejects.toMatchObject({ status: 409, code: "intake.reversal_conflict" });

      expect(await readCase(fixture.caseId)).toMatchObject({ stage: "submitted", workflowEventSequence: before.workflowEventSequence });
      expect(await database.intakeCaseReversalOperation.count({ where: { caseId: fixture.caseId } })).toBe(0);
    });

    it("rejects a stale stage with 409", async () => {
      const fixture = await createCase("submitted");
      await expect(
        requestReversal(fixture, "return_to_draft", { expectedStage: "pre_offering_open" }),
      ).rejects.toMatchObject({ status: 409, code: "intake.reversal_conflict" });
    });

    it("rejects a command the stage does not offer", async () => {
      const fixture = await createCase("submitted");
      await expect(requestReversal(fixture, "reopen_pre_offering")).rejects.toMatchObject({
        status: 409,
        code: "intake.reversal_not_allowed",
      });
      expect(await database.intakeCaseReversalOperation.count({ where: { caseId: fixture.caseId } })).toBe(0);
    });

    it("rejects reopening the review while an investor reservation exists", async () => {
      const fixture = await createCase("pre_offering_open");
      await addReservation(fixture.offeringId!);
      await expect(requestReversal(fixture, "reopen_pre_offering")).rejects.toMatchObject({
        status: 409,
        code: "intake.reversal_not_allowed",
      });
    });

    it("allows reopening the review when the only reservations were cancelled or lapsed", async () => {
      const fixture = await createCase("pre_offering_open");
      await addReservation(fixture.offeringId!, { stage: "cancelled" });
      await addReservation(fixture.offeringId!, { stage: "lapsed" });
      expect((await requestReversal(fixture, "reopen_pre_offering")).data.status).toBe("pending_approval");
    });

    it("rejects a second request while the first is still pending", async () => {
      const fixture = await createCase("pre_offering_open");
      await requestReversal(fixture, "reopen_pre_offering");
      await expect(requestReversal(fixture, "reopen_pre_offering")).rejects.toMatchObject({ status: 409 });
      expect(await database.intakeCaseReversalOperation.count({ where: { caseId: fixture.caseId } })).toBe(1);
    });

    it("refuses to create an operation from a stale snapshot even when the service check was already passed", async () => {
      // The service reads the snapshot outside any lock, so another action can
      // land between that read and the insert. The repository must re-check
      // under the case lock, otherwise it records an operation that can never
      // run.
      const fixture = await createCase("pre_offering_open");
      const before = await readCase(fixture.caseId);
      await bumpSequence(fixture.caseId);

      await expect(
        intakeRepository.createReversalOperation({
          caseId: fixture.caseId,
          command: "reopen_pre_offering",
          fromStage: "pre_offering_open",
          toStage: "submitted",
          status: "pending_approval",
          reasonCode: "operator_input_error",
          reason: "stale snapshot",
          requestedByAccountId: requesterId,
          expectedStage: "pre_offering_open",
          expectedWorkflowEventSequence: before.workflowEventSequence,
          reversalOfEventId: fixture.transitions.pre_offering_open ?? null,
          idempotencyKey: uid("key"),
          traceId: uid("trace"),
        }),
      ).rejects.toBeInstanceOf(CaseReviewConflictError);

      expect(await database.intakeCaseReversalOperation.count({ where: { caseId: fixture.caseId } })).toBe(0);
      expect((await readCase(fixture.caseId)).workflowEventSequence).toBe(before.workflowEventSequence + 1);
    });
  });

  describe("request-time guards under the case lock", () => {
    it("also refuses when only the stage differs from the caller's snapshot", async () => {
      const fixture = await createCase("pre_offering_open");
      const before = await readCase(fixture.caseId);
      // A write that changes the stage without appending a ledger event.
      await database.intakeCase.update({ where: { id: fixture.caseId }, data: { stage: "submitted" } });

      await expect(
        intakeRepository.createReversalOperation({
          caseId: fixture.caseId,
          command: "reopen_pre_offering",
          fromStage: "pre_offering_open",
          toStage: "submitted",
          status: "pending_approval",
          reasonCode: "operator_input_error",
          reason: "stage moved underneath",
          requestedByAccountId: requesterId,
          expectedStage: "pre_offering_open",
          expectedWorkflowEventSequence: before.workflowEventSequence,
          reversalOfEventId: fixture.transitions.pre_offering_open ?? null,
          idempotencyKey: uid("key"),
          traceId: uid("trace"),
        }),
      ).rejects.toBeInstanceOf(CaseReviewConflictError);
      expect(await database.intakeCaseReversalOperation.count({ where: { caseId: fixture.caseId } })).toBe(0);
    });
  });

  describe("simultaneous identical requests", () => {
    it("creates exactly one operation and turns the loser away with a 409 rather than a database error", async () => {
      const fixture = await createCase("pre_offering_open");
      const current = await readCase(fixture.caseId);
      const input = {
        caseId: fixture.caseId,
        command: "reopen_pre_offering",
        accountId: requesterId,
        traceId: uid("trace"),
        idempotencyKey: uid("key"),
        expectedStage: current.stage,
        expectedWorkflowEventSequence: current.workflowEventSequence,
        reasonCode: "operator_input_error",
        reason: "double click",
      };

      const outcomes = await Promise.allSettled([requestService.execute(input), requestService.execute(input)]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const loser = outcomes.find((outcome) => outcome.status === "rejected");
      expect(loser?.status === "rejected" && loser.reason).toMatchObject({ status: 409, code: "intake.reversal_conflict" });
      expect(await database.intakeCaseReversalOperation.count({ where: { caseId: fixture.caseId } })).toBe(1);
    });
  });

  describe("execution re-checks", () => {
    it("fails an approval whose case moved on since the request, and frees the case for a new correction", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await requestReversal(fixture, "reopen_pre_offering");
      await bumpSequence(fixture.caseId);

      await expect(approve(fixture, requested.data.operation_id)).rejects.toMatchObject({
        status: 409,
        code: "intake.reversal_conflict",
      });

      expect(await readOperation(requested.data.operation_id)).toMatchObject({
        status: "failed",
        failureCode: "case_changed",
        failedAt: now,
        completedAt: null,
      });
      // nothing was rewound
      expect((await readCase(fixture.caseId)).stage).toBe("pre_offering_open");
      expect((await database.offering.findUniqueOrThrow({ where: { id: fixture.offeringId! } })).status).toBe("pre_offering");
      expect(await readAudit(fixture.caseId, "intake.reopen_pre_offering")).toHaveLength(0);
      // ...and the failure is on the audit trail, attributed to the approver
      const failureAudit = await readAudit(fixture.caseId, "intake.correction_failed");
      expect(failureAudit).toHaveLength(1);
      expect(failureAudit[0]).toMatchObject({
        actorAccountId: approverId,
        resourceType: "intake_case",
        changes: { operation_id: requested.data.operation_id, command: "reopen_pre_offering", failure_code: "case_changed" },
      });
      // the failed operation no longer blocks the case: it can be corrected again
      await expect(snapshotCorrectionsInProgress(fixture.caseId)).resolves.toBe(false);
      const retried = await requestReversal(fixture, "reopen_pre_offering");
      expect(retried.data.status).toBe("pending_approval");
      expect((await approve(fixture, retried.data.operation_id)).data.status).toBe("completed");
    });

    it("fails an approval when only the stage differs from what was requested, even if the sequence still matches", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await requestReversal(fixture, "reopen_pre_offering");
      // A write that changes the stage without appending a ledger event.
      await database.intakeCase.update({ where: { id: fixture.caseId }, data: { stage: "submitted" } });

      await expect(approve(fixture, requested.data.operation_id)).rejects.toMatchObject({ status: 409, code: "intake.reversal_conflict" });

      expect(await readOperation(requested.data.operation_id)).toMatchObject({ status: "failed", failureCode: "case_changed" });
      expect((await database.offering.findUniqueOrThrow({ where: { id: fixture.offeringId! } })).status).toBe("pre_offering");
    });

    it("fails an approval of a stale single-person operation instead of leaving it requested forever", async () => {
      const fixture = await createCase("submitted");
      const current = await readCase(fixture.caseId);
      const created = await intakeRepository.createReversalOperation({
        caseId: fixture.caseId,
        command: "return_to_draft",
        fromStage: "submitted",
        toStage: "draft",
        status: "requested",
        reasonCode: "operator_input_error",
        reason: "created, then the case moved before it ran",
        requestedByAccountId: requesterId,
        expectedStage: "submitted",
        expectedWorkflowEventSequence: current.workflowEventSequence,
        reversalOfEventId: fixture.transitions.submitted ?? null,
        idempotencyKey: uid("key"),
        traceId: uid("trace"),
      });
      await bumpSequence(fixture.caseId);

      const executed = await intakeRepository.executeReversalOperation({
        caseId: fixture.caseId,
        operationId: created.operationId,
        actorAccountId: requesterId,
        traceId: uid("trace"),
        completedAt: now,
      });

      expect(executed).toMatchObject({ operationId: created.operationId, status: "failed", failureCode: "case_changed" });
      expect((await readCase(fixture.caseId)).stage).toBe("submitted");
      await expect(snapshotCorrectionsInProgress(fixture.caseId)).resolves.toBe(false);
    });

    it("fails an approval when a reservation arrived after the request, and leaves the offering open", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await requestReversal(fixture, "reopen_pre_offering");
      const sequenceAtRequest = (await readCase(fixture.caseId)).workflowEventSequence;

      // A real investor reservation through the offering domain's own path.
      const created = await offeringRepository.createReservation({
        reservationId: uid("reservation_rev"),
        offeringId: fixture.offeringId!,
        accountId: investorId,
        amountEur: "5000.00",
        disclosurePackVersionAtReservation: null,
        traceId: uid("trace"),
        createdAt: new Date(),
      });
      expect(created.conflict).toBeNull();
      // The reservation does not move the case's workflow sequence, so the
      // stage-and-sequence check alone cannot notice it.
      expect((await readCase(fixture.caseId)).workflowEventSequence).toBe(sequenceAtRequest);

      await expect(approve(fixture, requested.data.operation_id)).rejects.toMatchObject({
        status: 409,
        code: "intake.reversal_not_allowed",
      });

      expect(await readOperation(requested.data.operation_id)).toMatchObject({ status: "failed", failureCode: "not_allowed", failedAt: now, completedAt: null });
      expect((await readAudit(fixture.caseId, "intake.correction_failed"))[0]).toMatchObject({
        actorAccountId: approverId,
        changes: { operation_id: requested.data.operation_id, failure_code: "not_allowed" },
      });
      expect((await readCase(fixture.caseId)).stage).toBe("pre_offering_open");
      expect(await database.offering.findUniqueOrThrow({ where: { id: fixture.offeringId! } })).toMatchObject({ status: "pre_offering" });
      expect(await readAudit(fixture.caseId, "intake.reopen_pre_offering")).toHaveLength(0);
      expect(await database.reservation.count({ where: { offeringId: fixture.offeringId! } })).toBe(1);
      await expect(snapshotCorrectionsInProgress(fixture.caseId)).resolves.toBe(false);
    });

    it("fails an approval when funding landed after the request", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await requestReversal(fixture, "reopen_pre_offering");
      await addReservation(fixture.offeringId!, { stage: "initiated", capitalState: "eurc_reserved" });

      await expect(approve(fixture, requested.data.operation_id)).rejects.toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });
      expect((await database.offering.findUniqueOrThrow({ where: { id: fixture.offeringId! } })).status).toBe("pre_offering");
    });

    it("fails an approval when the disclosure pack was published after the request", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await requestReversal(fixture, "reopen_pre_offering");
      await database.disclosurePack.create({
        data: { id: uid("pack_rev"), offeringId: fixture.offeringId!, version: 1, publishedAt: now },
      });

      await expect(approve(fixture, requested.data.operation_id)).rejects.toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });
      expect((await readCase(fixture.caseId)).stage).toBe("pre_offering_open");
    });

    it("fails an approval of reopen_structuring when final terms were published after the request", async () => {
      const fixture = await createCase("post_ipo_structuring");
      const requested = await requestReversal(fixture, "reopen_structuring");
      await database.offering.update({ where: { id: fixture.offeringId! }, data: { finalOfferingPublishedAt: now } });

      await expect(approve(fixture, requested.data.operation_id)).rejects.toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });
      expect((await readCase(fixture.caseId)).stage).toBe("post_ipo_structuring");
    });

    it.each([
      [
        "final terms were published",
        "final_terms_published",
        (offeringId: string) => database.offering.update({ where: { id: offeringId }, data: { finalOfferingPublishedAt: now } }),
      ],
      [
        "a reservation was finalized",
        "offering_finalized",
        (offeringId: string) => addReservation(offeringId, { stage: "finalized", capitalState: "eurc_finalized" }),
      ],
      [
        "a reconfirmation was opened",
        "reconfirmation_open",
        (offeringId: string) => addReservation(offeringId, { stage: "awaiting_reconfirmation", capitalState: "reconfirmation_pending" }),
      ],
    ])("fails an approval of reopen_final_offering_review when %s after the request (%s)", async (_name, _blocker, arrive) => {
      const fixture = await createCase("approved_for_final_offering");
      const requested = await requestReversal(fixture, "reopen_final_offering_review");
      await arrive(fixture.offeringId!);

      await expect(approve(fixture, requested.data.operation_id)).rejects.toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });

      expect(await readOperation(requested.data.operation_id)).toMatchObject({ status: "failed", failureCode: "not_allowed" });
      expect(await readCase(fixture.caseId)).toMatchObject({ stage: "approved_for_final_offering", approvedForFinalOfferingAt: decidedAt });
      expect(await readAudit(fixture.caseId, "intake.reopen_final_offering_review")).toHaveLength(0);
    });

    it("waits for an in-flight reservation to commit before deciding, so none can slip in behind the close", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await requestReversal(fixture, "reopen_pre_offering");
      const reservationLocked = deferred();
      const releaseReservation = deferred();

      // Same lock-then-insert shape as PrismaOfferingRepository.createReservation,
      // held open so the approval has to contend with it.
      const inFlightReservation = database.$transaction(
        async (transaction) => {
          await transaction.$queryRaw`SELECT offering_id FROM offering.offerings WHERE offering_id = ${fixture.offeringId!} FOR UPDATE`;
          await transaction.reservation.create({
            data: {
              id: uid("reservation_rev"),
              offeringId: fixture.offeringId!,
              accountId: investorId,
              amountEur: "2500.00",
              reservationStage: "initiated",
            },
          });
          reservationLocked.resolve();
          await releaseReservation.promise;
        },
        { timeout: 20_000 },
      );
      await reservationLocked.promise;

      const approving = approve(fixture, requested.data.operation_id);
      expect(await stillPendingAfter(approving, 400)).toBe(true);

      releaseReservation.resolve();
      await inFlightReservation;
      await expect(approving).rejects.toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });
      expect((await database.offering.findUniqueOrThrow({ where: { id: fixture.offeringId! } })).status).toBe("pre_offering");
      expect(await database.reservation.count({ where: { offeringId: fixture.offeringId! } })).toBe(1);
    });

    it("waits for another action on the case to commit before deciding, so it never runs on a stale read", async () => {
      const fixture = await createCase("submitted");
      const created = await requestReversalOperationRow(fixture);
      const caseLocked = deferred();
      const releaseCase = deferred();

      // Another action on the same case: it takes the case row lock, records an
      // event (moving the workflow sequence), and has not committed yet.
      const otherAction = database.$transaction(
        async (transaction) => {
          await transaction.$queryRaw`SELECT case_id FROM intake.intake_cases WHERE case_id = ${fixture.caseId} FOR UPDATE`;
          await appendIntakeCaseEvent(transaction, {
            caseId: fixture.caseId,
            eventKey: `case:${fixture.caseId}:fixture:${uid("concurrent")}`,
            eventType: "case_evidence_reviewed",
            actorType: "staff",
            actorAccountId: approverId,
            occurredAt: now,
          });
          caseLocked.resolve();
          await releaseCase.promise;
        },
        { timeout: 20_000 },
      );
      await caseLocked.promise;

      const executing = intakeRepository.executeReversalOperation({
        caseId: fixture.caseId,
        operationId: created.operationId,
        actorAccountId: requesterId,
        traceId: uid("trace"),
        completedAt: now,
      });
      expect(await stillPendingAfter(executing, 400)).toBe(true);

      releaseCase.resolve();
      await otherAction;
      // Having waited, it sees the other action's event and refuses to run.
      await expect(executing).resolves.toMatchObject({ status: "failed", failureCode: "case_changed" });
      expect((await readCase(fixture.caseId)).stage).toBe("submitted");
    });

    it("lets only one of two simultaneous approvers claim a pending operation", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await requestReversal(fixture, "reopen_pre_offering");
      const secondApproverId = `acct_rev_approver2_${suffix}`;
      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [`auth_${secondApproverId}`, "Second Approver", `${secondApproverId}@example.test`, true, "customer"],
      );
      await database.account.create({ data: { id: secondApproverId, betterAuthUserId: `auth_${secondApproverId}` } });

      const outcomes = await Promise.allSettled(
        [approverId, secondApproverId].map((approverAccountId) =>
          intakeRepository.approveReversalOperation({
            caseId: fixture.caseId,
            operationId: requested.data.operation_id,
            approverAccountId,
            approvedAt: now,
          }),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const loser = outcomes.find((outcome) => outcome.status === "rejected");
      expect(loser?.status === "rejected" && loser.reason).toBeInstanceOf(CaseReviewConflictError);
      const stored = await readOperation(requested.data.operation_id);
      const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
      expect(stored.approvedByAccountId).toBe(winner?.status === "fulfilled" ? winner.value?.approvedByAccountId : undefined);
    });
  });

  describe("an approval that was claimed but never executed", () => {
    // approveReversalOperation and executeReversalOperation are separate
    // transactions, so a process that dies between them leaves the operation
    // approved: in flight for the policy, and refused by a second approval.
    async function claimWithoutExecuting(command: string, stage: FixtureStage) {
      const fixture = await createCase(stage);
      const requested = await requestReversal(fixture, command);
      await intakeRepository.approveReversalOperation({
        caseId: fixture.caseId,
        operationId: requested.data.operation_id,
        approverAccountId: approverId,
        approvedAt: new Date("2026-10-01T08:59:00.000Z"),
      });
      expect(await readOperation(requested.data.operation_id)).toMatchObject({ status: "approved", approvedByAccountId: approverId });
      return { fixture, operationId: requested.data.operation_id };
    }

    it("blocks further corrections until it is finished", async () => {
      const { fixture } = await claimWithoutExecuting("reopen_pre_offering", "pre_offering_open");
      await expect(snapshotCorrectionsInProgress(fixture.caseId)).resolves.toBe(true);
      await expect(requestReversal(fixture, "reopen_pre_offering")).rejects.toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });
    });

    it("is finished when the account that approved it approves again, keeping the original approval", async () => {
      const { fixture, operationId } = await claimWithoutExecuting("reopen_pre_offering", "pre_offering_open");

      const resumed = await approve(fixture, operationId, approverId);

      expect(resumed.data).toMatchObject({ status: "completed", approved_by_account_id: approverId, completed_at: now.toISOString() });
      expect(await readOperation(operationId)).toMatchObject({
        status: "completed",
        approvedByAccountId: approverId,
        approvedAt: new Date("2026-10-01T08:59:00.000Z"),
        completedAt: now,
      });
      expect(await readCase(fixture.caseId)).toMatchObject({ stage: "submitted", approvedAt: null });
      expect((await database.offering.findUniqueOrThrow({ where: { id: fixture.offeringId! } })).status).toBe("closed");
      expect(await readAudit(fixture.caseId, "intake.reopen_pre_offering")).toHaveLength(1);
      await expect(snapshotCorrectionsInProgress(fixture.caseId)).resolves.toBe(false);
    });

    it("is not finished by the requester, nor by an account that did not approve it", async () => {
      const { fixture, operationId } = await claimWithoutExecuting("reopen_structuring", "post_ipo_structuring");

      await expect(approve(fixture, operationId, requesterId)).rejects.toMatchObject({ status: 409, code: "intake.reversal_conflict" });
      await expect(approve(fixture, operationId, investorId)).rejects.toMatchObject({ status: 409, code: "intake.reversal_conflict" });

      expect(await readOperation(operationId)).toMatchObject({ status: "approved", approvedByAccountId: approverId });
      expect((await readCase(fixture.caseId)).stage).toBe("post_ipo_structuring");
    });

    it("still runs the execution-time checks when it is finished late", async () => {
      const { fixture, operationId } = await claimWithoutExecuting("reopen_pre_offering", "pre_offering_open");
      await addReservation(fixture.offeringId!, { capitalState: "eurc_reserved" });

      await expect(approve(fixture, operationId, approverId)).rejects.toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });

      expect(await readOperation(operationId)).toMatchObject({ status: "failed", failureCode: "not_allowed" });
      expect((await database.offering.findUniqueOrThrow({ where: { id: fixture.offeringId! } })).status).toBe("pre_offering");
    });

    it("is finished once even when the approver submits it twice at the same time", async () => {
      const { fixture, operationId } = await claimWithoutExecuting("reopen_pre_offering", "pre_offering_open");

      const outcomes = await Promise.all([approve(fixture, operationId, approverId), approve(fixture, operationId, approverId)]);

      expect(outcomes.map((outcome) => outcome.data.status)).toEqual(["completed", "completed"]);
      expect(await readAudit(fixture.caseId, "intake.reopen_pre_offering")).toHaveLength(1);
      expect(await readEvents(fixture.caseId).then((events) => events.filter((event) => event.eventType === "case_stage_reverted"))).toHaveLength(1);
    });
  });

  describe("execution that cannot finish", () => {
    it("records an unexpected execution error as a failed operation and releases the case", async () => {
      const fixture = await createCase("submitted");
      const current = await readCase(fixture.caseId);
      // from_stage = to_stage is rejected by the ledger's reversal trigger at the
      // very end of execution, after the case row has already been rewritten, so
      // the whole transaction rolls back.
      const created = await intakeRepository.createReversalOperation({
        caseId: fixture.caseId,
        command: "return_to_draft",
        fromStage: "submitted",
        toStage: "submitted",
        status: "requested",
        reasonCode: "operator_input_error",
        reason: "provokes a ledger error",
        requestedByAccountId: requesterId,
        expectedStage: "submitted",
        expectedWorkflowEventSequence: current.workflowEventSequence,
        reversalOfEventId: fixture.transitions.submitted ?? null,
        idempotencyKey: uid("key"),
        traceId: uid("trace"),
      });

      await expect(
        intakeRepository.executeReversalOperation({
          caseId: fixture.caseId,
          operationId: created.operationId,
          actorAccountId: requesterId,
          traceId: uid("trace"),
          completedAt: now,
        }),
      ).rejects.toThrow();

      expect(await readOperation(created.operationId)).toMatchObject({
        status: "failed",
        failureCode: "execution_error",
        failedAt: now,
        completedAt: null,
      });
      expect((await readCase(fixture.caseId)).stage).toBe("submitted");
      expect(await readAudit(fixture.caseId, "intake.return_to_draft")).toHaveLength(0);
      expect((await readAudit(fixture.caseId, "intake.correction_failed"))[0]).toMatchObject({
        actorAccountId: requesterId,
        changes: { operation_id: created.operationId, command: "return_to_draft", failure_code: "execution_error" },
      });
      await expect(snapshotCorrectionsInProgress(fixture.caseId)).resolves.toBe(false);
    });

    it("reports the failure of the failure recording as well, and leaves the operation in flight", async () => {
      const fixture = await createCase("submitted");
      const current = await readCase(fixture.caseId);
      const created = await intakeRepository.createReversalOperation({
        caseId: fixture.caseId,
        command: "return_to_draft",
        fromStage: "submitted",
        toStage: "submitted",
        status: "requested",
        reasonCode: "operator_input_error",
        reason: "provokes a ledger error",
        requestedByAccountId: requesterId,
        expectedStage: "submitted",
        expectedWorkflowEventSequence: current.workflowEventSequence,
        reversalOfEventId: fixture.transitions.submitted ?? null,
        idempotencyKey: uid("key"),
        traceId: uid("trace"),
      });
      // The execution transaction runs for real and fails on the ledger; the
      // transaction that would record the failure cannot reach the database.
      let transactions = 0;
      const unreachable = new Proxy(database, {
        get(target, property) {
          if (property !== "$transaction") return Reflect.get(target, property, target);
          return async (...args: Parameters<typeof target.$transaction>) => {
            if (++transactions === 2) throw new Error("recorder cannot reach the database");
            return (target.$transaction as (...inner: unknown[]) => Promise<unknown>)(...args);
          };
        },
      });
      const repository = new PrismaIntakeRepository(unreachable, boss, new PrismaKycRepository(database, boss));

      const error = await repository
        .executeReversalOperation({ caseId: fixture.caseId, operationId: created.operationId, actorAccountId: requesterId, traceId: uid("trace"), completedAt: now })
        .then(
          () => undefined,
          (rejected: unknown) => rejected,
        );

      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.message).toContain("recorder cannot reach the database");
      expect(aggregate.message).toContain("reversal events require a stage transition");
      expect(aggregate.errors).toHaveLength(2);
      expect((aggregate.cause as Error).message).toContain("reversal events require a stage transition");
      expect(await readOperation(created.operationId)).toMatchObject({ status: "requested", failedAt: null, failureCode: null });
      expect((await readCase(fixture.caseId)).stage).toBe("submitted");
    });

    it("never turns an operation that did complete into a failed one when only the acknowledgement was lost", async () => {
      const fixture = await createCase("submitted");
      const created = await requestReversalOperationRow(fixture);
      // Commits the real transaction, then reports an error for the first call
      // only, as a dropped connection after COMMIT would.
      let dropAcknowledgement = true;
      const flaky = new Proxy(database, {
        get(target, property) {
          if (property !== "$transaction") return Reflect.get(target, property, target);
          return async (...args: Parameters<typeof target.$transaction>) => {
            const result = await (target.$transaction as (...inner: unknown[]) => Promise<unknown>)(...args);
            if (dropAcknowledgement) {
              dropAcknowledgement = false;
              throw new Error("connection lost after commit");
            }
            return result;
          };
        },
      });
      const repository = new PrismaIntakeRepository(flaky, boss, new PrismaKycRepository(database, boss));

      await expect(
        repository.executeReversalOperation({
          caseId: fixture.caseId,
          operationId: created.operationId,
          actorAccountId: requesterId,
          traceId: uid("trace"),
          completedAt: now,
        }),
      ).rejects.toThrow("connection lost after commit");

      expect(await readOperation(created.operationId)).toMatchObject({ status: "completed", failedAt: null, failureCode: null });
      expect((await readCase(fixture.caseId)).stage).toBe("draft");
      expect(await readAudit(fixture.caseId, "intake.correction_failed")).toHaveLength(0);
    });

    it("fails, rather than wedges, a withdraw_information_request operation, which has no executor", async () => {
      const fixture = await createCase("waiting_on_applicant");
      const current = await readCase(fixture.caseId);
      const created = await intakeRepository.createReversalOperation({
        caseId: fixture.caseId,
        command: "withdraw_information_request",
        fromStage: "waiting_on_applicant",
        toStage: "submitted",
        status: "requested",
        reasonCode: "operator_input_error",
        reason: "no executor for this command",
        requestedByAccountId: requesterId,
        expectedStage: "waiting_on_applicant",
        expectedWorkflowEventSequence: current.workflowEventSequence,
        reversalOfEventId: fixture.transitions.waiting_on_applicant ?? null,
        idempotencyKey: uid("key"),
        traceId: uid("trace"),
      });

      const executed = await intakeRepository.executeReversalOperation({
        caseId: fixture.caseId,
        operationId: created.operationId,
        actorAccountId: requesterId,
        traceId: uid("trace"),
        completedAt: now,
      });

      expect(executed).toMatchObject({ status: "failed", failureCode: "not_allowed" });
      expect((await readCase(fixture.caseId)).stage).toBe("waiting_on_applicant");
      await expect(snapshotCorrectionsInProgress(fixture.caseId)).resolves.toBe(false);
    });
  });

  describe("idempotency and replay", () => {
    it("returns the stored operation for a repeated Idempotency-Key without writing a second set of rows", async () => {
      const fixture = await createCase("pre_offering_open");
      const current = await readCase(fixture.caseId);
      const input = {
        caseId: fixture.caseId,
        command: "reopen_pre_offering",
        fromStage: "pre_offering_open",
        toStage: "submitted",
        status: "pending_approval",
        reasonCode: "operator_input_error",
        reason: "replayed",
        requestedByAccountId: requesterId,
        expectedStage: "pre_offering_open",
        expectedWorkflowEventSequence: current.workflowEventSequence,
        reversalOfEventId: fixture.transitions.pre_offering_open ?? null,
        idempotencyKey: uid("key"),
        traceId: uid("trace"),
      };

      const first = await intakeRepository.createReversalOperation(input);
      const second = await intakeRepository.createReversalOperation(input);

      expect(second).toEqual(first);
      expect(second.operationId).toEqual(expect.any(String));
      expect(await database.intakeCaseReversalOperation.count({ where: { caseId: fixture.caseId } })).toBe(1);
      expect(await readAudit(fixture.caseId, "intake.correction_requested")).toHaveLength(1);
      expect((await readEvents(fixture.caseId)).filter((event) => event.eventType === "correction_requested")).toHaveLength(1);
    });

    it("scopes an Idempotency-Key to its case", async () => {
      const first = await createCase("submitted");
      const second = await createCase("submitted");
      const key = uid("shared_key");
      const a = await requestReversal(first, "return_to_draft", { idempotencyKey: key });
      const b = await requestReversal(second, "return_to_draft", { idempotencyKey: key });
      expect(a.data.operation_id).not.toBe(b.data.operation_id);
      expect(b.data.case_id).toBe(second.caseId);
    });

    it("hands back a well-formed record when execution is repeated for an operation that already completed", async () => {
      const fixture = await createCase("submitted");
      const done = await requestReversal(fixture, "return_to_draft");
      const sequenceAfter = (await readCase(fixture.caseId)).workflowEventSequence;

      const replay = await intakeRepository.executeReversalOperation({
        caseId: fixture.caseId,
        operationId: done.data.operation_id,
        actorAccountId: approverId,
        traceId: uid("trace"),
        completedAt: new Date("2026-10-02T09:00:00.000Z"),
      });

      expect(replay).toMatchObject({
        operationId: done.data.operation_id,
        caseId: fixture.caseId,
        command: "return_to_draft",
        status: "completed",
        completedAt: now,
      });
      // and it did nothing a second time
      expect((await readCase(fixture.caseId)).workflowEventSequence).toBe(sequenceAfter);
      expect(await readAudit(fixture.caseId, "intake.return_to_draft")).toHaveLength(1);
    });

    it("returns null when executing an operation that does not exist on the case", async () => {
      const fixture = await createCase("submitted");
      await expect(
        intakeRepository.executeReversalOperation({
          caseId: fixture.caseId,
          operationId: `rev_missing_${suffix}`,
          actorAccountId: requesterId,
          traceId: uid("trace"),
          completedAt: now,
        }),
      ).resolves.toBeNull();
    });
  });

  // These pin what the code does today so the next change to it is a visible,
  // deliberate one. They are not an endorsement of the behaviour.
  describe("known gaps (characterized, not endorsed)", () => {
    it("answers a client that retries with the same Idempotency-Key and headers with 409, not with the stored operation", async () => {
      // The service compares If-Match-Workflow-Sequence with the live sequence
      // before the repository ever sees the Idempotency-Key, and the first
      // request's own ledger event has already moved that sequence on.
      const fixture = await createCase("pre_offering_open");
      const current = await readCase(fixture.caseId);
      const input = {
        caseId: fixture.caseId,
        command: "reopen_pre_offering",
        accountId: requesterId,
        traceId: uid("trace"),
        idempotencyKey: uid("key"),
        expectedStage: current.stage,
        expectedWorkflowEventSequence: current.workflowEventSequence,
        reasonCode: "operator_input_error",
        reason: "retried",
      };

      const first = await requestService.execute(input);
      expect(first.data.status).toBe("pending_approval");
      await expect(requestService.execute(input)).rejects.toMatchObject({ status: 409, code: "intake.reversal_conflict" });
      expect(await database.intakeCaseReversalOperation.count({ where: { caseId: fixture.caseId } })).toBe(1);
    });
  });

  describe("rewinding the same transition twice", () => {
    // A reversal records the latest non-reversal transition as the event it
    // reverses, and the ledger allows each event to be reversed once. After
    // reopen_structuring that latest transition is still the one just
    // reversed, so a second rewind has nothing left to target. It is withheld
    // rather than offered and then failed at the ledger.
    async function reopenStructuring() {
      const fixture = await createCase("post_ipo_structuring");
      const first = await requestReversal(fixture, "reopen_structuring");
      await approve(fixture, first.data.operation_id);
      expect((await readCase(fixture.caseId)).stage).toBe("pre_offering_open");
      return { fixture, first };
    }

    it("reports that the latest transition has already been reversed", async () => {
      const { fixture, first } = await reopenStructuring();
      const snapshot = await intakeRepository.getIntakeReversalSnapshot(fixture.caseId);
      expect(snapshot).toMatchObject({
        latestTransition: { eventId: first.data.reversal_of_event_id },
        latestTransitionReversed: true,
      });
      const untouched = await createCase("post_ipo_structuring");
      expect((await intakeRepository.getIntakeReversalSnapshot(untouched.caseId))?.latestTransitionReversed).toBe(false);
    });

    it("does not offer a second rewind, and refuses to create one with a 409 domain error", async () => {
      const { fixture } = await reopenStructuring();

      const preview = await previewService.execute(fixture.caseId);
      expect(preview.data).toMatchObject({ available: false, correction_in_progress: false, actions: [] });
      await expect(requestReversal(fixture, "reopen_pre_offering")).rejects.toMatchObject({
        status: 409,
        code: "intake.reversal_not_allowed",
      });

      expect(await database.intakeCaseReversalOperation.count({ where: { caseId: fixture.caseId } })).toBe(1);
      expect(await readAudit(fixture.caseId, "intake.correction_requested")).toHaveLength(1);
      expect((await readCase(fixture.caseId)).stage).toBe("pre_offering_open");
      await expect(snapshotCorrectionsInProgress(fixture.caseId)).resolves.toBe(false);
    });

    it("withholds reopen_structuring after reopen_final_offering_review, which reversed the same transition", async () => {
      const fixture = await createCase("approved_for_final_offering");
      const first = await requestReversal(fixture, "reopen_final_offering_review");
      await approve(fixture, first.data.operation_id);
      expect((await readCase(fixture.caseId)).stage).toBe("post_ipo_structuring");

      await expect(requestReversal(fixture, "reopen_structuring")).rejects.toMatchObject({
        status: 409,
        code: "intake.reversal_not_allowed",
      });
      expect(await database.intakeCaseReversalOperation.count({ where: { caseId: fixture.caseId } })).toBe(1);
    });

    it("offers a rewind again once the case has made the transition anew", async () => {
      const { fixture } = await reopenStructuring();
      // The partner completes structuring a second time: a new transition event,
      // which is not reversed.
      await appendFixtureEvents(fixture.caseId, [
        { key: "post_ipo_structuring_again", type: "case_post_ipo_structuring_started", from: "pre_offering_open", to: "post_ipo_structuring" },
      ]);
      await database.intakeCase.update({ where: { id: fixture.caseId }, data: { stage: "post_ipo_structuring" } });

      const second = await requestReversal(fixture, "reopen_structuring");
      expect(second.data.status).toBe("pending_approval");
      expect((await approve(fixture, second.data.operation_id)).data.status).toBe("completed");
      expect((await readCase(fixture.caseId)).stage).toBe("pre_offering_open");
    });

    it("fails an operation that targets an already reversed event as not allowed at approval, instead of hitting the ledger", async () => {
      const { fixture, first } = await reopenStructuring();
      const current = await readCase(fixture.caseId);
      // What an operation requested before the transition was withheld looks like.
      const stale = await intakeRepository.createReversalOperation({
        caseId: fixture.caseId,
        command: "reopen_pre_offering",
        fromStage: "pre_offering_open",
        toStage: "submitted",
        status: "pending_approval",
        reasonCode: "operator_input_error",
        reason: "requested before a rewind of the same transition was withheld",
        requestedByAccountId: requesterId,
        expectedStage: current.stage,
        expectedWorkflowEventSequence: current.workflowEventSequence,
        reversalOfEventId: first.data.reversal_of_event_id,
        idempotencyKey: uid("key"),
        traceId: uid("trace"),
      });

      await expect(approve(fixture, stale.operationId)).rejects.toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });

      expect(await readOperation(stale.operationId)).toMatchObject({ status: "failed", failureCode: "not_allowed" });
      expect((await readCase(fixture.caseId)).stage).toBe("pre_offering_open");
      await expect(snapshotCorrectionsInProgress(fixture.caseId)).resolves.toBe(false);
    });
  });

  describe("known gaps: approving a reopened case again (through the real decision and offering handoff)", () => {
    const handoffQueue = "case_timers.pre_offering_open_handoff";
    const escrowQueue = "settlement.open_ipo_escrow_campaign";

    const cleanup: Array<() => Promise<void>> = [];

    beforeAll(async () => {
      await boss.start();
      await boss.createQueue(handoffQueue);
      await boss.createQueue(escrowQueue);
    }, 30_000);

    afterAll(async () => {
      for (const clean of cleanup) await clean();
    });

    async function approveAsFounder(caseId: string, decidedOn: Date) {
      const traceId = uid("trace_decision");
      await intakeRepository.recordFounderDecision({
        decision: "approve",
        accountId: requesterId,
        caseId,
        traceId,
        founderReviewNotes: "Looks good",
        decidedAt: decidedOn,
        ipoPeriodDays: 30,
        ipoEndAt: new Date(decidedOn.getTime() + 30 * 24 * 60 * 60 * 1000),
        ipoValueEur: "300000.00",
      });
      const jobs = await authPool.query<{ data: { case_id: string; property_id: string; ipo_value_eur: string; trace_id: string } }>(
        "SELECT data FROM pgboss.job WHERE name = $1 AND data->>'case_id' = $2 ORDER BY created_on DESC LIMIT 1",
        [handoffQueue, caseId],
      );
      return new OpenOfferingForApprovedCaseService(offeringRepository, { openEscrowCampaign: true }).execute(jobs.rows[0]?.data);
    }

    it("leaves the offering closed, and its escrow campaign job queued, so investors still cannot invest", async () => {
      const fixture = await createCase("submitted");
      const revisionId = uid("revision_rev");
      await database.submissionRevision.create({
        data: { id: revisionId, caseId: fixture.caseId, revisionNumber: 1, submittedByAccountId: applicantId, submissionData: {}, reason: "initial" },
      });
      await database.intakeCase.update({ where: { id: fixture.caseId }, data: { currentSubmissionRevisionId: revisionId } });

      // Approved and opened for real: a PIV, an offering and an escrow campaign job.
      const opened = await approveAsFounder(fixture.caseId, new Date("2026-10-02T10:00:00.000Z"));
      // The real handoff takes a token id from the shared sequence, which a
      // PIV left behind would hold for good.
      cleanup.push(async () => {
        await database.offering.deleteMany({ where: { pivId: opened.pivId } });
        await database.piv.deleteMany({ where: { id: opened.pivId } });
      });
      const escrowJobs = () =>
        authPool.query<{ state: string }>("SELECT state FROM pgboss.job WHERE name = $1 AND data->>'piv_id' = $2", [escrowQueue, opened.pivId]);
      expect((await escrowJobs()).rows).toHaveLength(1);

      const requested = await requestReversal(fixture, "reopen_pre_offering");
      await approve(fixture, requested.data.operation_id);
      expect((await readCase(fixture.caseId)).stage).toBe("submitted");
      expect((await database.offering.findUniqueOrThrow({ where: { id: opened.offeringId } })).status).toBe("closed");
      // Reopening does nothing about the escrow campaign job.
      expect((await escrowJobs()).rows.map((row) => row.state)).toEqual(["created"]);

      // The founder approves the case again.
      const reopened = await approveAsFounder(fixture.caseId, new Date("2026-10-03T10:00:00.000Z"));

      expect((await readCase(fixture.caseId)).stage).toBe("pre_offering_open");
      // The handoff finds the existing PIV and offering and returns them as they are:
      // nothing sets the offering back to pre_offering, and no campaign is opened.
      expect(reopened).toEqual(opened);
      expect((await database.offering.findUniqueOrThrow({ where: { id: opened.offeringId } })).status).toBe("closed");
      expect((await escrowJobs()).rows).toHaveLength(1);
      const reservation = await offeringRepository.createReservation({
        reservationId: uid("reservation_rev"),
        offeringId: opened.offeringId,
        accountId: investorId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: uid("trace"),
        createdAt: new Date(),
      });
      expect(reservation.conflict).toBe("offering_not_open");
    }, 30_000);
  });

  describe("reading an operation", () => {
    it("returns an operation only through the case it belongs to", async () => {
      const fixture = await createCase("pre_offering_open");
      const other = await createCase("submitted");
      const requested = await requestReversal(fixture, "reopen_pre_offering");

      await expect(intakeRepository.getReversalOperation(fixture.caseId, requested.data.operation_id)).resolves.toMatchObject({
        operationId: requested.data.operation_id,
        status: "pending_approval",
      });
      await expect(intakeRepository.getReversalOperation(other.caseId, requested.data.operation_id)).resolves.toBeNull();
    });
  });

  describe("HTTP surface over the real repository", () => {
    function httpApp() {
      const authenticate: RequestHandler = (httpRequest, response, next) => {
        response.locals.authContext = {
          accountId: String(httpRequest.header("x-test-account")),
          providerSessionId: "session_test",
          population: "staff_partner",
        };
        next();
      };
      const passThrough: RequestHandler = (_request, _response, next) => next();
      const unused = undefined as never;
      const server = express();
      server.use(express.json());
      server.use(requestContext);
      server.use(
        "/internal/v1/intake-cases",
        createIntakeOperationsRouter(
          authenticate,
          passThrough,
          passThrough,
          unused, // listCases
          unused, // getCase
          unused, // publishInformationRequest
          unused, // recordDecision
          unused, // closeCase
          unused, // listCaseMessages
          unused, // postCaseMessage
          unused, // createStaffCase
          unused, // retryPostIpoStructuringHandoff
          unused, // reviewEvidence
          unused, // forceExpireInformationRequest
          unused, // sendManualReminder
          unused, // withdrawInformationRequest
          unused, // readiness
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          previewService,
          requestService,
          approveService,
          new GetIntakeReversalOperationService(intakeRepository),
        ),
      );
      server.use(errorHandler);
      return server;
    }

    async function postCommand(fixture: Fixture, path: string, account: string, headers: Record<string, string> = {}) {
      const current = await readCase(fixture.caseId);
      return request(httpApp())
        .post(`/internal/v1/intake-cases/${fixture.caseId}/commands/${path}`)
        .set("x-test-account", account)
        .set("If-Match-Stage", current.stage)
        .set("If-Match-Workflow-Sequence", String(current.workflowEventSequence))
        .set("Idempotency-Key", uid("http_key"))
        .set(headers)
        .send({ reason_code: "wrong_case_selected", reason: "Selected the wrong case" });
    }

    it("runs return-to-draft end to end", async () => {
      const fixture = await createCase("submitted");
      const response = await postCommand(fixture, "return-to-draft", requesterId);
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ status: "completed", command: "return_to_draft", to_stage: "draft" });
      expect((await readCase(fixture.caseId)).stage).toBe("draft");
    });

    it("runs the two-person flow end to end and exposes the operation by id", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await postCommand(fixture, "reopen-pre-offering", requesterId);
      expect(requested.status).toBe(200);
      expect(requested.body.data.status).toBe("pending_approval");
      const operationId = requested.body.data.operation_id as string;

      const approved = await request(httpApp())
        .post(`/internal/v1/intake-cases/${fixture.caseId}/reversal-operations/${operationId}/approve`)
        .set("x-test-account", approverId);
      expect(approved.status).toBe(200);
      expect(approved.body.data).toMatchObject({ status: "completed", approved_by_account_id: approverId });

      const fetched = await request(httpApp())
        .get(`/internal/v1/intake-cases/${fixture.caseId}/reversal-operations/${operationId}`)
        .set("x-test-account", approverId);
      expect(fetched.status).toBe(200);
      expect(fetched.body.data).toMatchObject({ operation_id: operationId, status: "completed" });
    });

    it("answers a self-approval with a 409 domain error, not a 500", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await postCommand(fixture, "reopen-pre-offering", requesterId);

      const response = await request(httpApp())
        .post(`/internal/v1/intake-cases/${fixture.caseId}/reversal-operations/${requested.body.data.operation_id}/approve`)
        .set("x-test-account", requesterId);

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "intake.reversal_conflict", status: 409 });
    });

    it("answers a stale approval with a 409 domain error and then offers the correction again", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await postCommand(fixture, "reopen-pre-offering", requesterId);
      await bumpSequence(fixture.caseId);

      const approved = await request(httpApp())
        .post(`/internal/v1/intake-cases/${fixture.caseId}/reversal-operations/${requested.body.data.operation_id}/approve`)
        .set("x-test-account", approverId);
      expect(approved.status).toBe(409);
      expect(approved.body.code).toBe("intake.reversal_conflict");

      const preview = await request(httpApp())
        .get(`/internal/v1/intake-cases/${fixture.caseId}/reversal-preview`)
        .set("x-test-account", approverId);
      expect(preview.status).toBe(200);
      expect(preview.body.data).toMatchObject({ available: true, correction_in_progress: false });
      expect(preview.body.data.actions.map((action: { action: string }) => action.action)).toEqual(["reopen_pre_offering"]);

      const failed = await request(httpApp())
        .get(`/internal/v1/intake-cases/${fixture.caseId}/reversal-operations/${requested.body.data.operation_id}`)
        .set("x-test-account", approverId);
      expect(failed.body.data).toMatchObject({ status: "failed", failure_code: "case_changed" });
    });

    it("answers an approval that a new reservation has made unsafe with a 409 domain error", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await postCommand(fixture, "reopen-pre-offering", requesterId);
      await addReservation(fixture.offeringId!, { capitalState: "eurc_reserved" });

      const approved = await request(httpApp())
        .post(`/internal/v1/intake-cases/${fixture.caseId}/reversal-operations/${requested.body.data.operation_id}/approve`)
        .set("x-test-account", approverId);

      expect(approved.status).toBe(409);
      expect(approved.body.code).toBe("intake.reversal_not_allowed");
      expect((await database.offering.findUniqueOrThrow({ where: { id: fixture.offeringId! } })).status).toBe("pre_offering");
    });

    it("answers a second rewind of the same transition with a 409 domain error, not a 500, and offers nothing", async () => {
      const fixture = await createCase("post_ipo_structuring");
      const first = await postCommand(fixture, "reopen-structuring", requesterId);
      const approved = await request(httpApp())
        .post(`/internal/v1/intake-cases/${fixture.caseId}/reversal-operations/${first.body.data.operation_id}/approve`)
        .set("x-test-account", approverId);
      expect(approved.status).toBe(200);

      const second = await postCommand(fixture, "reopen-pre-offering", requesterId);
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: "intake.reversal_not_allowed", status: 409 });

      const preview = await request(httpApp())
        .get(`/internal/v1/intake-cases/${fixture.caseId}/reversal-preview`)
        .set("x-test-account", approverId);
      expect(preview.body.data).toMatchObject({ available: false, correction_in_progress: false, actions: [] });
    });

    it("lets the approver finish a claimed but unexecuted approval by approving again, and refuses everyone else", async () => {
      const fixture = await createCase("pre_offering_open");
      const requested = await postCommand(fixture, "reopen-pre-offering", requesterId);
      const operationId = requested.body.data.operation_id as string;
      await intakeRepository.approveReversalOperation({ caseId: fixture.caseId, operationId, approverAccountId: approverId, approvedAt: now });
      const approvalPath = `/internal/v1/intake-cases/${fixture.caseId}/reversal-operations/${operationId}/approve`;

      const other = await request(httpApp()).post(approvalPath).set("x-test-account", investorId);
      expect(other.status).toBe(409);
      expect(other.body.code).toBe("intake.reversal_conflict");

      const resumed = await request(httpApp()).post(approvalPath).set("x-test-account", approverId);
      expect(resumed.status).toBe(200);
      expect(resumed.body.data).toMatchObject({ status: "completed", approved_by_account_id: approverId });
      expect((await readCase(fixture.caseId)).stage).toBe("submitted");
    });

    it("answers a request with stale headers with a 409 domain error", async () => {
      const fixture = await createCase("submitted");
      const response = await postCommand(fixture, "return-to-draft", requesterId, { "If-Match-Workflow-Sequence": "0" });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("intake.reversal_conflict");
    });
  });
});

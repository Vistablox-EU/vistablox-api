import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { SessionResolver } from "../src/modules/auth/application/shared/session-resolver.js";
import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";
import {
  CaseReviewConflictError,
  type IntakeReversalOperationRecord,
  type IntakeReversalSnapshot,
  type IntakeRepository,
} from "../src/modules/intake/repository/intake.repository.js";

const caseId = "case_01";
const base = `/internal/v1/intake-cases/${caseId}`;

function snapshot(overrides: Partial<IntakeReversalSnapshot> = {}): IntakeReversalSnapshot {
  return {
    caseId,
    stage: "submitted",
    workflowEventSequence: 7,
    latestTransition: { eventId: "evt_submitted", fromStage: "draft", toStage: "submitted" },
    latestTransitionReversed: false,
    activeInformationRequest: false,
    offering: null,
    legalExecutionCompleted: false,
    appraisalCompleted: false,
    correctionInProgress: false,
    ...overrides,
  };
}

function offering(overrides: Partial<NonNullable<IntakeReversalSnapshot["offering"]>> = {}) {
  return {
    offeringId: "offering_01",
    status: "pre_offering",
    finalOfferingPublishedAt: null,
    reservationCount: 0,
    fundedReservationCount: 0,
    disclosurePackPublished: false,
    reconfirmationOpen: false,
    finalizedReservationCount: 0,
    ...overrides,
  };
}

function operation(overrides: Partial<IntakeReversalOperationRecord> = {}): IntakeReversalOperationRecord {
  return {
    operationId: "rev_01",
    caseId,
    command: "return_to_draft",
    fromStage: "submitted",
    toStage: "draft",
    status: "completed",
    reasonCode: "wrong_case_selected",
    reason: "Selected the wrong case",
    requestedByAccountId: "acct_founder",
    approvedByAccountId: null,
    expectedStage: "submitted",
    expectedWorkflowEventSequence: 8,
    reversalOfEventId: "evt_submitted",
    idempotencyKey: "key-1",
    createdAt: new Date("2026-10-01T08:00:00.000Z"),
    approvedAt: null,
    startedAt: new Date("2026-10-01T09:00:00.000Z"),
    completedAt: new Date("2026-10-01T09:00:00.000Z"),
    failedAt: null,
    failureCode: null,
    failureDetail: null,
    ...overrides,
  };
}

function fakeEmailSender(): EmailSender {
  return {
    sendStaffInvitationEmail: vi.fn(),
    sendApplicantResponseReminderEmail: vi.fn(),
    sendKycRenewalReminderEmail: vi.fn(),
    sendReconfirmationReminderEmail: vi.fn(),
    sendReconfirmationWindowOpenedEmail: vi.fn(),
    sendAccountRecoveryCaseOpenedEmail: vi.fn(),
    sendAccountRecoveryApprovedEmail: vi.fn(),
    sendAccountRecoveryRejectedEmail: vi.fn(),
    sendAccountRecoveryCompletedEmail: vi.fn(),
    sendPasskeyRecoveryEmail: vi.fn(),
    sendDeviceReplacementCodeEmail: vi.fn(),
  };
}

interface BuildOptions {
  authenticated?: boolean;
  population?: "customer" | "staff_partner";
  hasAdminRole?: boolean;
  mfaVerified?: boolean;
  snapshot?: IntakeReversalSnapshot | null;
  create?: ReturnType<typeof vi.fn>;
  execute?: ReturnType<typeof vi.fn>;
  approve?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
}

function buildApp(options: BuildOptions = {}) {
  const sessions: SessionResolver = {
    resolve: vi.fn().mockResolvedValue(
      options.authenticated === false
        ? null
        : {
            betterAuthUserId: "auth_actor",
            providerSessionId: "session_actor",
            population: options.population ?? "staff_partner",
          },
    ),
  };
  const accounts: AccountRepository = {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({ accountId: "acct_founder", status: "active" }),
    findByEmail: vi.fn().mockResolvedValue([]),
    hasActiveStaffRole: vi.fn().mockResolvedValue(options.hasAdminRole ?? true),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(options.hasAdminRole ?? true),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn().mockResolvedValue(null),
  };
  const reversal = {
    getIntakeReversalSnapshot: vi.fn().mockResolvedValue(options.snapshot === undefined ? snapshot() : options.snapshot),
    createReversalOperation: options.create ?? vi.fn().mockResolvedValue(operation()),
    getReversalOperation: options.get ?? vi.fn().mockResolvedValue(operation()),
    approveReversalOperation: options.approve ?? vi.fn().mockResolvedValue(operation({ status: "approved", approvedByAccountId: "acct_founder" })),
    executeReversalOperation: options.execute ?? vi.fn().mockResolvedValue(operation()),
  };
  // Only the reversal methods are reachable from these routes; the rest of the
  // repository is never called, so it is left out rather than stubbed.
  const intakeRepository = reversal as unknown as IntakeRepository;
  const app = createApp({
    databaseProbe: { check: vi.fn() },
    offeringRepository: {
      listPublic: vi.fn().mockResolvedValue([]),
      getInvestorDetail: vi.fn().mockResolvedValue(null),
    },
    logger: pino({ level: "silent" }),
    corsOrigins: [],
    protectedApi: {
      accounts,
      sessions,
      intakeRepository,
      emailSender: fakeEmailSender(),
      staffWebAuthnRepository: {
        listCredentials: vi.fn().mockResolvedValue([]),
        findCredential: vi.fn().mockResolvedValue(null),
        isSessionVerified: vi.fn().mockResolvedValue(options.mfaVerified ?? true),
        replaceChallenge: vi.fn(),
        getActiveChallenge: vi.fn().mockResolvedValue(null),
        failChallenge: vi.fn().mockResolvedValue(false),
        completeRegistration: vi.fn().mockResolvedValue(false),
        completeAuthentication: vi.fn().mockResolvedValue(false),
      },
      staffWebAuthnCeremony: {
        generateRegistrationOptions: vi.fn(),
        verifyRegistration: vi.fn(),
        generateAuthenticationOptions: vi.fn(),
        verifyAuthentication: vi.fn(),
      },
    },
  });
  return { app, reversal };
}

type App = ReturnType<typeof createApp>;

const validBody = { reason_code: "wrong_case_selected", reason: "Selected the wrong case" };

function withRequestHeaders(test: request.Test, overrides: Record<string, string | undefined> = {}) {
  const headers: Record<string, string | undefined> = {
    "If-Match-Stage": "submitted",
    "If-Match-Workflow-Sequence": "7",
    "Idempotency-Key": "key-1",
    ...overrides,
  };
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) test.set(name, value);
  return test;
}

// One entry per route, in the order the router registers them.
const routes = [
  { name: "GET reversal-preview", send: (app: App) => request(app).get(`${base}/reversal-preview`) },
  { name: "POST commands/return-to-draft", send: (app: App) => withRequestHeaders(request(app).post(`${base}/commands/return-to-draft`)).send(validBody) },
  { name: "POST commands/reopen-pre-offering", send: (app: App) => withRequestHeaders(request(app).post(`${base}/commands/reopen-pre-offering`)).send(validBody) },
  { name: "POST commands/reopen-structuring", send: (app: App) => withRequestHeaders(request(app).post(`${base}/commands/reopen-structuring`)).send(validBody) },
  { name: "POST commands/reopen-final-offering-review", send: (app: App) => withRequestHeaders(request(app).post(`${base}/commands/reopen-final-offering-review`)).send(validBody) },
  { name: "POST reversal-operations/:id/approve", send: (app: App) => request(app).post(`${base}/reversal-operations/rev_01/approve`) },
  { name: "GET reversal-operations/:id", send: (app: App) => request(app).get(`${base}/reversal-operations/rev_01`) },
] as const;

function expectNoRepositoryCalls(reversal: ReturnType<typeof buildApp>["reversal"]) {
  for (const method of Object.values(reversal)) expect(method).not.toHaveBeenCalled();
}

describe("intake reversal routes: authorization", () => {
  describe.each(routes)("$name", ({ send }) => {
    it("rejects an unauthenticated caller with 401 before touching the repository", async () => {
      const { app, reversal } = buildApp({ authenticated: false });
      const response = await send(app);
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("authentication.required");
      expectNoRepositoryCalls(reversal);
    });

    it("rejects a customer, even one holding the admin role flag, with 403", async () => {
      const { app, reversal } = buildApp({ population: "customer", hasAdminRole: true });
      const response = await send(app);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("authorization.forbidden");
      expectNoRepositoryCalls(reversal);
    });

    it("rejects a staff account without the admin operations role with 403", async () => {
      const { app, reversal } = buildApp({ hasAdminRole: false });
      const response = await send(app);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("authorization.forbidden");
      expectNoRepositoryCalls(reversal);
    });

    it("rejects an admin whose session has not completed WebAuthn with 403", async () => {
      const { app, reversal } = buildApp({ mfaVerified: false });
      const response = await send(app);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("authentication.staff_mfa_required");
      expectNoRepositoryCalls(reversal);
    });
  });
});

describe("GET /reversal-preview", () => {
  it("serves the schema-validated preview for the case", async () => {
    const { app, reversal } = buildApp({
      snapshot: snapshot({
        stage: "pre_offering_open",
        workflowEventSequence: 12,
        latestTransition: { eventId: "evt_approved", fromStage: "submitted", toStage: "pre_offering_open" },
        offering: offering(),
      }),
    });

    const response = await request(app).get(`${base}/reversal-preview`);

    expect(response.status).toBe(200);
    expect(reversal.getIntakeReversalSnapshot).toHaveBeenCalledWith(caseId);
    expect(response.body.data).toMatchObject({
      case_id: caseId,
      stage: "pre_offering_open",
      workflow_event_sequence: 12,
      available: true,
      correction_in_progress: false,
      actions: [{ action: "reopen_pre_offering", target_stage: "submitted", requires_second_approval: true, blockers: [] }],
    });
  });

  it("answers 404 for an unknown case", async () => {
    const { app } = buildApp({ snapshot: null });
    const response = await request(app).get(`${base}/reversal-preview`);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("intake.case_not_found");
  });
});

describe("POST /commands/*", () => {
  const cases = [
    { path: "return-to-draft", command: "return_to_draft", snapshot: snapshot(), expectedStage: "submitted", toStage: "draft", status: "requested" },
    {
      path: "reopen-pre-offering",
      command: "reopen_pre_offering",
      snapshot: snapshot({ stage: "pre_offering_open", offering: offering() }),
      expectedStage: "pre_offering_open",
      toStage: "submitted",
      status: "pending_approval",
    },
    {
      path: "reopen-structuring",
      command: "reopen_structuring",
      snapshot: snapshot({ stage: "post_ipo_structuring", offering: offering() }),
      expectedStage: "post_ipo_structuring",
      toStage: "pre_offering_open",
      status: "pending_approval",
    },
    {
      path: "reopen-final-offering-review",
      command: "reopen_final_offering_review",
      snapshot: snapshot({ stage: "approved_for_final_offering", offering: offering() }),
      expectedStage: "approved_for_final_offering",
      toStage: "post_ipo_structuring",
      status: "pending_approval",
    },
  ] as const;

  it.each(cases)("$path requests the $command command as the signed-in account", async ({ path, command, snapshot: current, expectedStage, toStage, status }) => {
    const { app, reversal } = buildApp({
      snapshot: current,
      create: vi.fn().mockResolvedValue(operation({ command, fromStage: expectedStage, toStage, status })),
    });

    const response = await withRequestHeaders(
      request(app).post(`${base}/commands/${path}`).set("x-trace-id", "trace_from_client"),
      { "If-Match-Stage": expectedStage, "If-Match-Workflow-Sequence": "7", "Idempotency-Key": "key-77" },
    ).send({ reason_code: "duplicate_case", reason: "  Duplicate of case_99  " });

    expect(response.status).toBe(200);
    expect(reversal.createReversalOperation).toHaveBeenCalledWith({
      caseId,
      command,
      fromStage: expectedStage,
      toStage,
      status,
      reasonCode: "duplicate_case",
      reason: "Duplicate of case_99",
      requestedByAccountId: "acct_founder",
      expectedStage,
      expectedWorkflowEventSequence: 7,
      reversalOfEventId: "evt_submitted",
      idempotencyKey: "key-77",
      traceId: "trace_from_client",
    });
    expect(response.body.data).toMatchObject({ operation_id: "rev_01", command, from_stage: expectedStage, to_stage: toStage });
  });

  it("executes a single-person command at once and leaves a two-person command waiting", async () => {
    const single = buildApp();
    const singleResponse = await withRequestHeaders(request(single.app).post(`${base}/commands/return-to-draft`)).send(validBody);
    expect(singleResponse.status).toBe(200);
    expect(single.reversal.executeReversalOperation).toHaveBeenCalledWith(
      expect.objectContaining({ caseId, operationId: "rev_01", actorAccountId: "acct_founder" }),
    );

    const double = buildApp({
      snapshot: snapshot({ stage: "pre_offering_open", offering: offering() }),
      create: vi.fn().mockResolvedValue(operation({ command: "reopen_pre_offering", status: "pending_approval" })),
    });
    const doubleResponse = await withRequestHeaders(request(double.app).post(`${base}/commands/reopen-pre-offering`), {
      "If-Match-Stage": "pre_offering_open",
    }).send(validBody);
    expect(doubleResponse.status).toBe(200);
    expect(doubleResponse.body.data.status).toBe("pending_approval");
    expect(double.reversal.executeReversalOperation).not.toHaveBeenCalled();
  });

  describe("required headers", () => {
    it.each([
      ["If-Match-Stage", undefined],
      ["If-Match-Workflow-Sequence", undefined],
      ["If-Match-Workflow-Sequence", "seven"],
      ["If-Match-Workflow-Sequence", "7.5"],
      ["Idempotency-Key", undefined],
      ["Idempotency-Key", "   "],
    ])("rejects %s = %j with 422 and touches nothing", async (header, value) => {
      const { app, reversal } = buildApp();
      const response = await withRequestHeaders(request(app).post(`${base}/commands/return-to-draft`), { [header]: value }).send(validBody);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe("intake.reversal_headers_required");
      expectNoRepositoryCalls(reversal);
    });
  });

  describe("request body", () => {
    it.each([
      ["a missing reason", { reason_code: "wrong_case_selected" }],
      ["a blank reason", { reason_code: "wrong_case_selected", reason: "   " }],
      ["an over-long reason", { reason_code: "wrong_case_selected", reason: "x".repeat(501) }],
      ["a missing reason code", { reason: "because" }],
      ["an unknown reason code", { reason_code: "because_i_said_so", reason: "because" }],
    ])("rejects %s with 422 and field errors", async (_name, body) => {
      const { app, reversal } = buildApp();
      const response = await withRequestHeaders(request(app).post(`${base}/commands/return-to-draft`)).send(body);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe("validation.invalid_field");
      expect(response.body.field_errors.length).toBeGreaterThan(0);
      expectNoRepositoryCalls(reversal);
    });

    it("accepts a reason of exactly 500 characters", async () => {
      const { app } = buildApp();
      const response = await withRequestHeaders(request(app).post(`${base}/commands/return-to-draft`)).send({
        reason_code: "wrong_case_selected",
        reason: "x".repeat(500),
      });
      expect(response.status).toBe(200);
    });
  });

  describe("error mapping", () => {
    it("answers 404 for an unknown case", async () => {
      const { app, reversal } = buildApp({ snapshot: null });
      const response = await withRequestHeaders(request(app).post(`${base}/commands/return-to-draft`)).send(validBody);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("intake.case_not_found");
      expect(reversal.createReversalOperation).not.toHaveBeenCalled();
    });

    it("answers 409 with the documented envelope when the headers are stale", async () => {
      const { app, reversal } = buildApp();
      const response = await withRequestHeaders(request(app).post(`${base}/commands/return-to-draft`).set("x-trace-id", "trace_stale"), {
        "If-Match-Workflow-Sequence": "6",
      }).send(validBody);
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        type: "https://api.vistablox.io/errors/intake.reversal_conflict",
        code: "intake.reversal_conflict",
        title: "Case changed",
        status: 409,
        detail: "The case changed while this correction was being prepared. Refresh and try again.",
        trace_id: "trace_stale",
      });
      expect(reversal.createReversalOperation).not.toHaveBeenCalled();
    });

    it("answers 409 when the stage does not offer the command", async () => {
      const { app } = buildApp();
      const response = await withRequestHeaders(request(app).post(`${base}/commands/reopen-structuring`)).send(validBody);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("intake.reversal_not_allowed");
    });

    it("answers 409 when an investor reservation blocks reopening the review", async () => {
      const { app, reversal } = buildApp({ snapshot: snapshot({ stage: "pre_offering_open", offering: offering({ reservationCount: 1 }) }) });
      const response = await withRequestHeaders(request(app).post(`${base}/commands/reopen-pre-offering`), {
        "If-Match-Stage": "pre_offering_open",
      }).send(validBody);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("intake.reversal_not_allowed");
      expect(reversal.createReversalOperation).not.toHaveBeenCalled();
    });

    it("answers 409, not 500, when the repository detects a conflict under its lock", async () => {
      const { app } = buildApp({ create: vi.fn().mockRejectedValue(new CaseReviewConflictError("submitted", "request this reversal")) });
      const response = await withRequestHeaders(request(app).post(`${base}/commands/return-to-draft`)).send(validBody);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("intake.reversal_conflict");
    });

    it("answers 409, not 500, when execution finds the case changed", async () => {
      const { app } = buildApp({ execute: vi.fn().mockRejectedValue(new CaseReviewConflictError("submitted", "execute this reversal")) });
      const response = await withRequestHeaders(request(app).post(`${base}/commands/return-to-draft`)).send(validBody);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("intake.reversal_conflict");
    });

    it("answers 409 when execution recorded the operation as failed", async () => {
      const { app } = buildApp({
        execute: vi.fn().mockResolvedValue(operation({ status: "failed", completedAt: null, failedAt: new Date(), failureCode: "not_allowed", failureDetail: "blocked" })),
      });
      const response = await withRequestHeaders(request(app).post(`${base}/commands/return-to-draft`)).send(validBody);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("intake.reversal_not_allowed");
    });

    it("answers a generic 500 without leaking the cause when something unexpected fails", async () => {
      const { app } = buildApp({ create: vi.fn().mockRejectedValue(new Error("connection to 10.0.0.5 refused")) });
      const response = await withRequestHeaders(request(app).post(`${base}/commands/return-to-draft`)).send(validBody);
      expect(response.status).toBe(500);
      expect(response.body.code).toBe("internal.unexpected");
      expect(JSON.stringify(response.body)).not.toContain("10.0.0.5");
    });
  });
});

describe("POST /reversal-operations/:operation_id/approve", () => {
  it("approves and executes as the signed-in account", async () => {
    const { app, reversal } = buildApp({
      approve: vi.fn().mockResolvedValue(operation({ command: "reopen_pre_offering", status: "approved", approvedByAccountId: "acct_founder" })),
      execute: vi.fn().mockResolvedValue(operation({ command: "reopen_pre_offering", approvedByAccountId: "acct_founder" })),
    });

    const response = await request(app).post(`${base}/reversal-operations/rev_01/approve`).set("x-trace-id", "trace_approve");

    expect(response.status).toBe(200);
    expect(reversal.approveReversalOperation).toHaveBeenCalledWith(
      expect.objectContaining({ caseId, operationId: "rev_01", approverAccountId: "acct_founder" }),
    );
    expect(reversal.executeReversalOperation).toHaveBeenCalledWith(
      expect.objectContaining({ caseId, operationId: "rev_01", actorAccountId: "acct_founder", traceId: "trace_approve" }),
    );
    expect(response.body.data).toMatchObject({ status: "completed", approved_by_account_id: "acct_founder" });
  });

  it("answers 404 for an unknown operation", async () => {
    const { app, reversal } = buildApp({ approve: vi.fn().mockResolvedValue(null) });
    const response = await request(app).post(`${base}/reversal-operations/rev_missing/approve`);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("intake.reversal_operation_not_found");
    expect(reversal.executeReversalOperation).not.toHaveBeenCalled();
  });

  it("answers 409, not 500, when the approver is refused (own request, or no longer pending)", async () => {
    const { app, reversal } = buildApp({
      approve: vi.fn().mockRejectedValue(new CaseReviewConflictError("pre_offering_open", "approve this reversal")),
    });
    const response = await request(app).post(`${base}/reversal-operations/rev_01/approve`);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "intake.reversal_conflict", status: 409 });
    expect(reversal.executeReversalOperation).not.toHaveBeenCalled();
  });

  it("answers 409, not 500, when the case changed between the request and the approval", async () => {
    const { app } = buildApp({
      execute: vi.fn().mockResolvedValue(operation({ status: "failed", completedAt: null, failedAt: new Date(), failureCode: "case_changed", failureDetail: "stale" })),
    });
    const response = await request(app).post(`${base}/reversal-operations/rev_01/approve`);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("intake.reversal_conflict");
  });
});

describe("GET /reversal-operations/:operation_id", () => {
  it("returns the operation", async () => {
    const { app, reversal } = buildApp();
    const response = await request(app).get(`${base}/reversal-operations/rev_01`);
    expect(response.status).toBe(200);
    expect(reversal.getReversalOperation).toHaveBeenCalledWith(caseId, "rev_01");
    expect(response.body.data).toMatchObject({ operation_id: "rev_01", case_id: caseId, status: "completed" });
  });

  it("returns a failed operation as data, with its failure fields", async () => {
    const { app } = buildApp({
      get: vi.fn().mockResolvedValue(operation({ status: "failed", completedAt: null, failedAt: new Date("2026-10-01T09:30:00.000Z"), failureCode: "case_changed", failureDetail: "stale" })),
    });
    const response = await request(app).get(`${base}/reversal-operations/rev_01`);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: "failed", failed_at: "2026-10-01T09:30:00.000Z", failure_code: "case_changed", completed_at: null });
  });

  it("answers 404 for an operation that is not on this case", async () => {
    const { app } = buildApp({ get: vi.fn().mockResolvedValue(null) });
    const response = await request(app).get(`${base}/reversal-operations/rev_elsewhere`);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("intake.reversal_operation_not_found");
  });
});

describe("known gaps (characterized, not endorsed)", () => {
  it("advertises withdraw_information_request in the preview although no route can request it", async () => {
    const { app } = buildApp({
      snapshot: snapshot({
        stage: "waiting_on_applicant",
        activeInformationRequest: true,
        latestTransition: { eventId: "evt_waiting", fromStage: "submitted", toStage: "waiting_on_applicant" },
      }),
    });

    const preview = await request(app).get(`${base}/reversal-preview`);
    expect(preview.body.data.actions.map((action: { action: string }) => action.action)).toEqual(["withdraw_information_request"]);

    const attempt = await withRequestHeaders(request(app).post(`${base}/commands/withdraw-information-request`), {
      "If-Match-Stage": "waiting_on_applicant",
    }).send(validBody);
    expect(attempt.status).toBe(404);
  });

  it("never lists a blocked action with its blockers: the preview just hides it", async () => {
    const { app } = buildApp({
      snapshot: snapshot({
        stage: "pre_offering_open",
        offering: offering({ reservationCount: 2, fundedReservationCount: 1, disclosurePackPublished: true }),
      }),
    });
    const response = await request(app).get(`${base}/reversal-preview`);
    expect(response.body.data).toMatchObject({ available: false, actions: [] });
  });
});

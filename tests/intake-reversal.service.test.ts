import { describe, expect, it, vi, type Mock } from "vitest";

import {
  ApproveIntakeReversalService,
  CancelIntakeReversalService,
  GetIntakeReversalOperationService,
  GetIntakeReversalPreviewService,
  RequestIntakeReversalService,
  type ReversalRepository,
} from "../src/modules/intake/application/intake-reversal.service.js";
import {
  CaseReviewConflictError,
  ReversalApprovalRefusedError,
  ReversalNotCancellableError,
  type IntakeReversalOperationRecord,
  type IntakeReversalSnapshot,
} from "../src/modules/intake/repository/intake.repository.js";
import { AppError } from "../src/shared/errors/app-error.js";

const fixedNow = new Date("2026-10-01T09:00:00.000Z");

function reversalSnapshot(overrides: Partial<IntakeReversalSnapshot> = {}): IntakeReversalSnapshot {
  return {
    caseId: "case_01",
    stage: "submitted",
    workflowEventSequence: 7,
    latestTransition: { eventId: "evt_submitted", fromStage: "draft", toStage: "submitted" },
    latestTransitionReversed: false,
    activeInformationRequest: false,
    offering: null,
    legalExecutionCompleted: false,
    appraisalCompleted: false,
    activeOperation: null,
    correctionInProgress: false,
    ...overrides,
  };
}

// A snapshot of a case paused by this operation: the two fields always agree, as they do when the repository reads them.
function pausedBy(active: IntakeReversalOperationRecord, overrides: Partial<IntakeReversalSnapshot> = {}): IntakeReversalSnapshot {
  return reversalSnapshot({ stage: "pre_offering_open", offering: cleanOffering(), activeOperation: active, correctionInProgress: true, ...overrides });
}

function cleanOffering(overrides: Partial<NonNullable<IntakeReversalSnapshot["offering"]>> = {}) {
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
    caseId: "case_01",
    command: "return_to_draft",
    fromStage: "submitted",
    toStage: "draft",
    status: "requested",
    reasonCode: "operator_input_error",
    reason: "Wrong case selected",
    requestedByAccountId: "acct_requester",
    approvedByAccountId: null,
    expectedStage: "submitted",
    expectedWorkflowEventSequence: 8,
    reversalOfEventId: "evt_submitted",
    idempotencyKey: "key-1",
    createdAt: new Date("2026-10-01T08:00:00.000Z"),
    approvedAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    failureCode: null,
    failureDetail: null,
    ...overrides,
  };
}

type FakeRepository = Record<keyof ReversalRepository, Mock> & ReversalRepository;

function fakeRepository(overrides: Partial<Record<keyof ReversalRepository, Mock>> = {}): FakeRepository {
  const repository = {
    getIntakeReversalSnapshot: vi.fn().mockResolvedValue(reversalSnapshot()),
    createReversalOperation: vi.fn().mockResolvedValue(operation()),
    getReversalOperation: vi.fn().mockResolvedValue(operation()),
    approveReversalOperation: vi.fn().mockResolvedValue(operation({ status: "approved", approvedByAccountId: "acct_approver" })),
    cancelReversalOperation: vi.fn().mockResolvedValue(operation({ status: "cancelled" })),
    executeReversalOperation: vi.fn().mockResolvedValue(operation({ status: "completed", completedAt: fixedNow })),
    ...overrides,
  };
  return repository as FakeRepository;
}

const requestInput = {
  caseId: "case_01",
  command: "return_to_draft",
  accountId: "acct_requester",
  traceId: "trace_01",
  idempotencyKey: "key-1",
  expectedStage: "submitted",
  expectedWorkflowEventSequence: 7,
  reasonCode: "operator_input_error",
  reason: "Wrong case selected",
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("GetIntakeReversalPreviewService", () => {
  it("answers 404 for a case that does not exist", async () => {
    const repository = fakeRepository({ getIntakeReversalSnapshot: vi.fn().mockResolvedValue(null) });
    const error = await rejection(new GetIntakeReversalPreviewService(repository).execute("missing", "acct_viewer"));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 404, code: "intake.case_not_found" });
  });

  it("lists the available action with the metadata the admin panel needs", async () => {
    const repository = fakeRepository({
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(
        reversalSnapshot({
          stage: "pre_offering_open",
          workflowEventSequence: 12,
          latestTransition: { eventId: "evt_approved", fromStage: "submitted", toStage: "pre_offering_open" },
          offering: cleanOffering(),
        }),
      ),
    });

    const result = await new GetIntakeReversalPreviewService(repository).execute("case_01", "acct_viewer");

    expect(result.data).toEqual({
      case_id: "case_01",
      stage: "pre_offering_open",
      workflow_event_sequence: 12,
      latest_transition: { event_id: "evt_approved", from_stage: "submitted", to_stage: "pre_offering_open" },
      correction_in_progress: false,
      pending_operation: null,
      available: true,
      actions: [
        {
          action: "reopen_pre_offering",
          label: "Reopen review",
          target_stage: "submitted",
          requires_reason: true,
          requires_second_approval: true,
          execution_mode: "asynchronous",
          impact_summary: expect.any(String),
          blockers: [],
        },
      ],
    });
  });

  it("reports nothing available while a correction is already in progress", async () => {
    const repository = fakeRepository({
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(pausedBy(operation({ status: "pending_approval", command: "reopen_pre_offering" }))),
    });
    const result = await new GetIntakeReversalPreviewService(repository).execute("case_01", "acct_viewer");
    expect(result.data).toMatchObject({ available: false, actions: [], correction_in_progress: true });
  });

  describe("the pending operation", () => {
    const pending = operation({
      operationId: "rev_pending",
      command: "reopen_pre_offering",
      fromStage: "pre_offering_open",
      toStage: "submitted",
      status: "pending_approval",
      reasonCode: "offering_setup_correction",
      reason: "Terms were entered for the wrong property",
      requestedByAccountId: "acct_requester",
      createdAt: new Date("2026-10-01T08:30:00.000Z"),
    });

    async function previewAs(viewerAccountId: string, active: IntakeReversalOperationRecord = pending) {
      const repository = fakeRepository({ getIntakeReversalSnapshot: vi.fn().mockResolvedValue(pausedBy(active)) });
      return new GetIntakeReversalPreviewService(repository).execute("case_01", viewerAccountId);
    }

    it("is null, with correction_in_progress false, when nothing pauses the case", async () => {
      const repository = fakeRepository();
      const result = await new GetIntakeReversalPreviewService(repository).execute("case_01", "acct_viewer");
      expect(result.data.pending_operation).toBeNull();
      expect(result.data.correction_in_progress).toBe(false);
    });

    it("gives a second staff member everything needed to find and approve it", async () => {
      const result = await previewAs("acct_second");
      expect(result.data.correction_in_progress).toBe(true);
      expect(result.data.pending_operation).toEqual({
        operation_id: "rev_pending",
        command: "reopen_pre_offering",
        command_label: "Reopen review",
        from_stage: "pre_offering_open",
        to_stage: "submitted",
        status: "pending_approval",
        reason_code: "offering_setup_correction",
        reason: "Terms were entered for the wrong property",
        requested_by_account_id: "acct_requester",
        requested_at: "2026-10-01T08:30:00.000Z",
        viewer_can_approve: true,
        viewer_can_cancel: true,
      });
    });

    it("tells the requester they cannot approve their own request, but can cancel it", async () => {
      const result = await previewAs("acct_requester");
      expect(result.data.pending_operation).toMatchObject({ operation_id: "rev_pending", viewer_can_approve: false, viewer_can_cancel: true });
    });

    it.each([
      ["requested", { viewer_can_approve: false, viewer_can_cancel: true }],
      ["approved", { viewer_can_approve: false, viewer_can_cancel: false }],
      ["executing", { viewer_can_approve: false, viewer_can_cancel: false }],
    ] as const)("offers a %s operation to a second staff member as %j", async (status, expected) => {
      const result = await previewAs("acct_second", { ...pending, status });
      expect(result.data.pending_operation).toMatchObject({ status, ...expected });
    });

    it("lets the account that approved a claimed but unexecuted operation finish it, and nobody else", async () => {
      const claimed = { ...pending, status: "approved", approvedByAccountId: "acct_approver" };
      expect((await previewAs("acct_approver", claimed)).data.pending_operation).toMatchObject({ status: "approved", viewer_can_approve: true, viewer_can_cancel: false });
      expect((await previewAs("acct_requester", claimed)).data.pending_operation).toMatchObject({ status: "approved", viewer_can_approve: false, viewer_can_cancel: false });
      expect((await previewAs("acct_second", claimed)).data.pending_operation).toMatchObject({ status: "approved", viewer_can_approve: false, viewer_can_cancel: false });
    });

    it.each([
      ["return_to_draft", "Return to draft"],
      ["withdraw_information_request", "Withdraw information request"],
      ["reopen_pre_offering", "Reopen review"],
      ["reopen_structuring", "Reopen structuring"],
      ["reopen_final_offering_review", "Reopen final-offering review"],
    ])("labels a %s operation %j even though the pause hides every action", async (command, label) => {
      const result = await previewAs("acct_second", { ...pending, command });
      expect(result.data.pending_operation?.command_label).toBe(label);
      expect(result.data.actions).toEqual([]);
    });

    it("reports a correction in progress exactly when it names the operation", async () => {
      for (const [snapshot, inProgress] of [
        [reversalSnapshot(), false],
        [pausedBy(pending), true],
      ] as const) {
        const repository = fakeRepository({ getIntakeReversalSnapshot: vi.fn().mockResolvedValue(snapshot) });
        const result = await new GetIntakeReversalPreviewService(repository).execute("case_01", "acct_viewer");
        expect(result.data.correction_in_progress).toBe(inProgress);
        expect(result.data.pending_operation !== null).toBe(inProgress);
      }
    });
  });

  it("reports nothing available when a reservation blocks reopening the review", async () => {
    const repository = fakeRepository({
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(
        reversalSnapshot({ stage: "pre_offering_open", offering: cleanOffering({ reservationCount: 1 }) }),
      ),
    });
    const result = await new GetIntakeReversalPreviewService(repository).execute("case_01", "acct_viewer");
    expect(result.data).toMatchObject({ available: false, actions: [] });
  });

  it("reports nothing available when the transition a rewind would target has already been rewound", async () => {
    const repository = fakeRepository({
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(
        reversalSnapshot({ stage: "pre_offering_open", offering: cleanOffering(), latestTransitionReversed: true }),
      ),
    });
    const result = await new GetIntakeReversalPreviewService(repository).execute("case_01", "acct_viewer");
    expect(result.data).toMatchObject({ available: false, actions: [], correction_in_progress: false });
  });

  it("returns a null latest_transition when the case has none", async () => {
    const repository = fakeRepository({
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(reversalSnapshot({ stage: "draft", latestTransition: null })),
    });
    const result = await new GetIntakeReversalPreviewService(repository).execute("case_01", "acct_viewer");
    expect(result.data.latest_transition).toBeNull();
  });
});

describe("RequestIntakeReversalService", () => {
  it("answers 404 for a case that does not exist and writes nothing", async () => {
    const repository = fakeRepository({ getIntakeReversalSnapshot: vi.fn().mockResolvedValue(null) });
    const error = await rejection(new RequestIntakeReversalService(repository).execute(requestInput));
    expect(error).toMatchObject({ status: 404, code: "intake.case_not_found" });
    expect(repository.createReversalOperation).not.toHaveBeenCalled();
  });

  it("rejects a stale stage header with 409 and writes nothing", async () => {
    const repository = fakeRepository();
    const error = await rejection(
      new RequestIntakeReversalService(repository).execute({ ...requestInput, expectedStage: "waiting_on_applicant" }),
    );
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_conflict" });
    expect(repository.createReversalOperation).not.toHaveBeenCalled();
    expect(repository.executeReversalOperation).not.toHaveBeenCalled();
  });

  it("rejects a stale workflow sequence header with 409 and writes nothing", async () => {
    const repository = fakeRepository();
    const error = await rejection(
      new RequestIntakeReversalService(repository).execute({ ...requestInput, expectedWorkflowEventSequence: 6 }),
    );
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_conflict" });
    expect(repository.createReversalOperation).not.toHaveBeenCalled();
  });

  it("rejects a command the case's stage does not offer with 409", async () => {
    const repository = fakeRepository();
    const error = await rejection(
      new RequestIntakeReversalService(repository).execute({ ...requestInput, command: "reopen_structuring" }),
    );
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });
    expect(repository.createReversalOperation).not.toHaveBeenCalled();
  });

  it("rejects a reopen while a reservation exists", async () => {
    const repository = fakeRepository({
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(
        reversalSnapshot({
          stage: "pre_offering_open",
          offering: cleanOffering({ reservationCount: 2, fundedReservationCount: 1 }),
        }),
      ),
    });
    const error = await rejection(
      new RequestIntakeReversalService(repository).execute({
        ...requestInput,
        command: "reopen_pre_offering",
        expectedStage: "pre_offering_open",
      }),
    );
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });
    expect(repository.createReversalOperation).not.toHaveBeenCalled();
  });

  it("rejects a rewind whose target transition has already been rewound with 409, without creating an operation", async () => {
    const repository = fakeRepository({
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(
        reversalSnapshot({ stage: "pre_offering_open", offering: cleanOffering(), latestTransitionReversed: true }),
      ),
    });
    const error = await rejection(
      new RequestIntakeReversalService(repository).execute({
        ...requestInput,
        command: "reopen_pre_offering",
        expectedStage: "pre_offering_open",
      }),
    );
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });
    expect(repository.createReversalOperation).not.toHaveBeenCalled();
  });

  it.each([
    ["legal execution has completed", { legalExecutionCompleted: true }],
    ["the appraisal has completed", { appraisalCompleted: true }],
  ])("rejects reopening structuring once %s", async (_name, completion) => {
    const repository = fakeRepository({
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(
        reversalSnapshot({ stage: "post_ipo_structuring", offering: cleanOffering(), ...completion }),
      ),
    });
    const error = await rejection(
      new RequestIntakeReversalService(repository).execute({
        ...requestInput,
        command: "reopen_structuring",
        expectedStage: "post_ipo_structuring",
      }),
    );
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });
    expect(repository.createReversalOperation).not.toHaveBeenCalled();
  });

  it("rejects a request while another correction is in flight", async () => {
    const repository = fakeRepository({
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(
        reversalSnapshot({ activeOperation: operation({ status: "pending_approval" }), correctionInProgress: true }),
      ),
    });
    const error = await rejection(new RequestIntakeReversalService(repository).execute(requestInput));
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });
  });

  it.each([
    ["command", { command: "delete_everything" }],
    ["reason code", { reasonCode: "because" }],
  ])("rejects an unknown %s before touching the repository", async (_name, override) => {
    const repository = fakeRepository();
    await expect(new RequestIntakeReversalService(repository).execute({ ...requestInput, ...override })).rejects.toThrow();
    expect(repository.getIntakeReversalSnapshot).not.toHaveBeenCalled();
  });

  it("executes a single-person correction immediately and returns the completed operation", async () => {
    const repository = fakeRepository();
    const result = await new RequestIntakeReversalService(repository, () => fixedNow).execute(requestInput);

    expect(repository.createReversalOperation).toHaveBeenCalledWith({
      caseId: "case_01",
      command: "return_to_draft",
      fromStage: "submitted",
      toStage: "draft",
      status: "requested",
      reasonCode: "operator_input_error",
      reason: "Wrong case selected",
      requestedByAccountId: "acct_requester",
      expectedStage: "submitted",
      expectedWorkflowEventSequence: 7,
      reversalOfEventId: "evt_submitted",
      idempotencyKey: "key-1",
      traceId: "trace_01",
    });
    expect(repository.executeReversalOperation).toHaveBeenCalledWith({
      caseId: "case_01",
      operationId: "rev_01",
      actorAccountId: "acct_requester",
      traceId: "trace_01",
      completedAt: fixedNow,
    });
    expect(repository.createReversalOperation.mock.invocationCallOrder[0]).toBeLessThan(
      repository.executeReversalOperation.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result.data).toMatchObject({
      operation_id: "rev_01",
      status: "completed",
      command: "return_to_draft",
      from_stage: "submitted",
      to_stage: "draft",
      completed_at: "2026-10-01T09:00:00.000Z",
      failed_at: null,
    });
  });

  it("parks a two-person correction as pending approval without executing it", async () => {
    const repository = fakeRepository({
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(
        reversalSnapshot({
          stage: "pre_offering_open",
          latestTransition: { eventId: "evt_approved", fromStage: "submitted", toStage: "pre_offering_open" },
          offering: cleanOffering(),
        }),
      ),
      createReversalOperation: vi.fn().mockResolvedValue(
        operation({ command: "reopen_pre_offering", fromStage: "pre_offering_open", toStage: "submitted", status: "pending_approval" }),
      ),
    });

    const result = await new RequestIntakeReversalService(repository).execute({
      ...requestInput,
      command: "reopen_pre_offering",
      expectedStage: "pre_offering_open",
    });

    expect(repository.createReversalOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "reopen_pre_offering",
        fromStage: "pre_offering_open",
        toStage: "submitted",
        status: "pending_approval",
        reversalOfEventId: "evt_approved",
      }),
    );
    expect(repository.executeReversalOperation).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ status: "pending_approval", completed_at: null });
  });

  it("records no reversed event when the case has no transition yet", async () => {
    const repository = fakeRepository({
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(
        reversalSnapshot({
          stage: "waiting_on_applicant",
          activeInformationRequest: true,
          latestTransition: null,
        }),
      ),
    });
    await new RequestIntakeReversalService(repository).execute({
      ...requestInput,
      command: "withdraw_information_request",
      expectedStage: "waiting_on_applicant",
    });
    expect(repository.createReversalOperation).toHaveBeenCalledWith(
      expect.objectContaining({ command: "withdraw_information_request", toStage: "submitted", reversalOfEventId: null }),
    );
  });

  describe("conflicts raised by the repository", () => {
    it("maps a conflict thrown while creating the operation to a 409 domain error", async () => {
      const repository = fakeRepository({
        createReversalOperation: vi.fn().mockRejectedValue(new CaseReviewConflictError("draft", "create this reversal")),
      });
      const error = await rejection(new RequestIntakeReversalService(repository).execute(requestInput));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 409, code: "intake.reversal_conflict" });
      expect(repository.executeReversalOperation).not.toHaveBeenCalled();
    });

    it("maps a conflict thrown while executing to a 409 domain error", async () => {
      const repository = fakeRepository({
        executeReversalOperation: vi.fn().mockRejectedValue(new CaseReviewConflictError("draft", "execute this reversal")),
      });
      const error = await rejection(new RequestIntakeReversalService(repository).execute(requestInput));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 409, code: "intake.reversal_conflict" });
    });

    it("lets an unexpected failure through untouched", async () => {
      const boom = new Error("connection reset");
      const repository = fakeRepository({ executeReversalOperation: vi.fn().mockRejectedValue(boom) });
      await expect(new RequestIntakeReversalService(repository).execute(requestInput)).rejects.toBe(boom);
    });

    it("answers 409 when execution recorded that the case changed underneath the request", async () => {
      const repository = fakeRepository({
        executeReversalOperation: vi.fn().mockResolvedValue(
          operation({ status: "failed", failedAt: fixedNow, failureCode: "case_changed", failureDetail: "stale" }),
        ),
      });
      const error = await rejection(new RequestIntakeReversalService(repository).execute(requestInput));
      expect(error).toMatchObject({ status: 409, code: "intake.reversal_conflict" });
    });

    it("answers 409 when execution recorded that the correction is no longer allowed", async () => {
      const repository = fakeRepository({
        executeReversalOperation: vi.fn().mockResolvedValue(
          operation({ status: "failed", failedAt: fixedNow, failureCode: "not_allowed", failureDetail: "blocked" }),
        ),
      });
      const error = await rejection(new RequestIntakeReversalService(repository).execute(requestInput));
      expect(error).toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });
    });
  });
});

describe("ApproveIntakeReversalService", () => {
  const approveInput = { caseId: "case_01", operationId: "rev_01", accountId: "acct_approver", traceId: "trace_02" };

  it("answers 404 when the operation does not exist and never executes", async () => {
    const repository = fakeRepository({ approveReversalOperation: vi.fn().mockResolvedValue(null) });
    const error = await rejection(new ApproveIntakeReversalService(repository).execute(approveInput));
    expect(error).toMatchObject({ status: 404, code: "intake.reversal_operation_not_found" });
    expect(repository.executeReversalOperation).not.toHaveBeenCalled();
  });

  it("approves as the caller, then executes as the caller, and returns the completed operation", async () => {
    const repository = fakeRepository({
      executeReversalOperation: vi.fn().mockResolvedValue(
        operation({
          command: "reopen_pre_offering",
          status: "completed",
          approvedByAccountId: "acct_approver",
          completedAt: fixedNow,
        }),
      ),
    });

    const result = await new ApproveIntakeReversalService(repository, () => fixedNow).execute(approveInput);

    expect(repository.approveReversalOperation).toHaveBeenCalledWith({
      caseId: "case_01",
      operationId: "rev_01",
      approverAccountId: "acct_approver",
      approvedAt: fixedNow,
    });
    expect(repository.executeReversalOperation).toHaveBeenCalledWith({
      caseId: "case_01",
      operationId: "rev_01",
      actorAccountId: "acct_approver",
      traceId: "trace_02",
      completedAt: fixedNow,
    });
    expect(repository.approveReversalOperation.mock.invocationCallOrder[0]).toBeLessThan(
      repository.executeReversalOperation.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result.data).toMatchObject({
      status: "completed",
      approved_by_account_id: "acct_approver",
      requested_by_account_id: "acct_requester",
    });
  });

  it("maps an approval refused for another reason to a 409 conflict and never executes", async () => {
    const repository = fakeRepository({
      approveReversalOperation: vi.fn().mockRejectedValue(new CaseReviewConflictError("pre_offering_open", "approve this reversal")),
    });
    const error = await rejection(new ApproveIntakeReversalService(repository).execute(approveInput));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_conflict" });
    expect(repository.executeReversalOperation).not.toHaveBeenCalled();
  });

  it("answers 403 when the requester approves their own request, and never executes", async () => {
    const repository = fakeRepository({
      approveReversalOperation: vi.fn().mockRejectedValue(new ReversalApprovalRefusedError("pre_offering_open", "self_approval")),
    });
    const error = await rejection(new ApproveIntakeReversalService(repository).execute({ ...approveInput, accountId: "acct_requester" }));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 403, code: "intake.reversal_self_approval_forbidden" });
    expect(repository.executeReversalOperation).not.toHaveBeenCalled();
  });

  it("answers 409 when the operation is not awaiting approval, and never executes", async () => {
    const repository = fakeRepository({
      approveReversalOperation: vi.fn().mockRejectedValue(new ReversalApprovalRefusedError("pre_offering_open", "not_pending_approval")),
    });
    const error = await rejection(new ApproveIntakeReversalService(repository).execute(approveInput));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_not_pending_approval" });
    expect(repository.executeReversalOperation).not.toHaveBeenCalled();
  });

  it("maps a conflict thrown while executing to a 409 domain error", async () => {
    const repository = fakeRepository({
      executeReversalOperation: vi.fn().mockRejectedValue(new CaseReviewConflictError("submitted", "execute this reversal")),
    });
    const error = await rejection(new ApproveIntakeReversalService(repository).execute(approveInput));
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_conflict" });
  });

  it("answers 409 when execution recorded that the case changed since the request", async () => {
    const repository = fakeRepository({
      executeReversalOperation: vi.fn().mockResolvedValue(
        operation({ status: "failed", failedAt: fixedNow, failureCode: "case_changed", failureDetail: "stale" }),
      ),
    });
    const error = await rejection(new ApproveIntakeReversalService(repository).execute(approveInput));
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_conflict" });
  });

  it("answers 409 when execution recorded that a blocker appeared since the request", async () => {
    const repository = fakeRepository({
      executeReversalOperation: vi.fn().mockResolvedValue(
        operation({ status: "failed", failedAt: fixedNow, failureCode: "not_allowed", failureDetail: "blocked" }),
      ),
    });
    const error = await rejection(new ApproveIntakeReversalService(repository).execute(approveInput));
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_not_allowed" });
  });

  it("lets an unexpected failure through untouched", async () => {
    const boom = new Error("connection reset");
    const repository = fakeRepository({ approveReversalOperation: vi.fn().mockRejectedValue(boom) });
    await expect(new ApproveIntakeReversalService(repository).execute(approveInput)).rejects.toBe(boom);
  });
});

describe("CancelIntakeReversalService", () => {
  const cancelInput = { caseId: "case_01", operationId: "rev_01", accountId: "acct_canceller", traceId: "trace_03" };

  it("cancels as the caller, with the clock's time and no note by default, and returns the cancelled operation", async () => {
    const repository = fakeRepository({
      cancelReversalOperation: vi.fn().mockResolvedValue(operation({ command: "reopen_pre_offering", status: "cancelled" })),
    });

    const result = await new CancelIntakeReversalService(repository, () => fixedNow).execute(cancelInput);

    expect(repository.cancelReversalOperation).toHaveBeenCalledWith({
      caseId: "case_01",
      operationId: "rev_01",
      cancelledByAccountId: "acct_canceller",
      note: null,
      cancelledAt: fixedNow,
      traceId: "trace_03",
    });
    expect(result.data).toMatchObject({ operation_id: "rev_01", case_id: "case_01", command: "reopen_pre_offering", status: "cancelled", completed_at: null, failed_at: null });
  });

  it("passes the note on", async () => {
    const repository = fakeRepository();
    await new CancelIntakeReversalService(repository, () => fixedNow).execute({ ...cancelInput, note: "Requested against the wrong case" });
    expect(repository.cancelReversalOperation).toHaveBeenCalledWith(expect.objectContaining({ note: "Requested against the wrong case" }));
  });

  it("never approves or executes anything", async () => {
    const repository = fakeRepository();
    await new CancelIntakeReversalService(repository).execute(cancelInput);
    expect(repository.approveReversalOperation).not.toHaveBeenCalled();
    expect(repository.executeReversalOperation).not.toHaveBeenCalled();
  });

  it("answers 404 when the operation is not on the case", async () => {
    const repository = fakeRepository({ cancelReversalOperation: vi.fn().mockResolvedValue(null) });
    const error = await rejection(new CancelIntakeReversalService(repository).execute(cancelInput));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 404, code: "intake.reversal_operation_not_found" });
  });

  it("answers 409 when the operation is past cancelling", async () => {
    const repository = fakeRepository({ cancelReversalOperation: vi.fn().mockRejectedValue(new ReversalNotCancellableError("pre_offering_open")) });
    const error = await rejection(new CancelIntakeReversalService(repository).execute(cancelInput));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_not_cancellable" });
  });

  it("maps any other conflict the repository raises to the generic 409", async () => {
    const repository = fakeRepository({ cancelReversalOperation: vi.fn().mockRejectedValue(new CaseReviewConflictError("submitted", "cancel this reversal")) });
    const error = await rejection(new CancelIntakeReversalService(repository).execute(cancelInput));
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_conflict" });
  });

  it("lets an unexpected failure through untouched", async () => {
    const boom = new Error("connection reset");
    const repository = fakeRepository({ cancelReversalOperation: vi.fn().mockRejectedValue(boom) });
    await expect(new CancelIntakeReversalService(repository).execute(cancelInput)).rejects.toBe(boom);
  });
});

describe("GetIntakeReversalOperationService", () => {
  it("answers 404 when the operation is not on that case", async () => {
    const repository = fakeRepository({ getReversalOperation: vi.fn().mockResolvedValue(null) });
    const error = await rejection(
      new GetIntakeReversalOperationService(repository).execute({ caseId: "case_01", operationId: "rev_x" }),
    );
    expect(error).toMatchObject({ status: 404, code: "intake.reversal_operation_not_found" });
    expect(repository.getReversalOperation).toHaveBeenCalledWith("case_01", "rev_x");
  });

  it("returns the operation in every status, including failed with its failure fields", async () => {
    const repository = fakeRepository({
      getReversalOperation: vi.fn().mockResolvedValue(
        operation({ status: "failed", failedAt: fixedNow, failureCode: "case_changed", failureDetail: "stale" }),
      ),
    });
    const result = await new GetIntakeReversalOperationService(repository).execute({ caseId: "case_01", operationId: "rev_01" });
    expect(result.data).toMatchObject({
      status: "failed",
      failed_at: "2026-10-01T09:00:00.000Z",
      failure_code: "case_changed",
      failure_detail: "stale",
    });
  });
});

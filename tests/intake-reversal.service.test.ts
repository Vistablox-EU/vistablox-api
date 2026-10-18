import { describe, expect, it, vi, type Mock } from "vitest";

import {
  ApproveIntakeReversalService,
  GetIntakeReversalOperationService,
  GetIntakeReversalPreviewService,
  RequestIntakeReversalService,
  type ReversalRepository,
} from "../src/modules/intake/application/intake-reversal.service.js";
import {
  CaseReviewConflictError,
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
    activeInformationRequest: false,
    offering: null,
    legalExecutionCompleted: false,
    appraisalCompleted: false,
    correctionInProgress: false,
    ...overrides,
  };
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
    const error = await rejection(new GetIntakeReversalPreviewService(repository).execute("missing"));
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

    const result = await new GetIntakeReversalPreviewService(repository).execute("case_01");

    expect(result.data).toEqual({
      case_id: "case_01",
      stage: "pre_offering_open",
      workflow_event_sequence: 12,
      latest_transition: { event_id: "evt_approved", from_stage: "submitted", to_stage: "pre_offering_open" },
      correction_in_progress: false,
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
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(reversalSnapshot({ correctionInProgress: true })),
    });
    const result = await new GetIntakeReversalPreviewService(repository).execute("case_01");
    expect(result.data).toMatchObject({ available: false, actions: [], correction_in_progress: true });
  });

  it("reports nothing available when a reservation blocks reopening the review", async () => {
    const repository = fakeRepository({
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(
        reversalSnapshot({ stage: "pre_offering_open", offering: cleanOffering({ reservationCount: 1 }) }),
      ),
    });
    const result = await new GetIntakeReversalPreviewService(repository).execute("case_01");
    expect(result.data).toMatchObject({ available: false, actions: [] });
  });

  it("returns a null latest_transition when the case has none", async () => {
    const repository = fakeRepository({
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(reversalSnapshot({ stage: "draft", latestTransition: null })),
    });
    const result = await new GetIntakeReversalPreviewService(repository).execute("case_01");
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
      getIntakeReversalSnapshot: vi.fn().mockResolvedValue(reversalSnapshot({ correctionInProgress: true })),
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

  it("maps a refused approval (own request, or not awaiting approval) to a 409 domain error and never executes", async () => {
    const repository = fakeRepository({
      approveReversalOperation: vi.fn().mockRejectedValue(new CaseReviewConflictError("pre_offering_open", "approve this reversal")),
    });
    const error = await rejection(new ApproveIntakeReversalService(repository).execute(approveInput));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, code: "intake.reversal_conflict" });
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

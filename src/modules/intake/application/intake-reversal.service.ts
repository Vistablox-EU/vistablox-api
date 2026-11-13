import { AppError } from "../../../shared/errors/app-error.js";
import { getReversalAction, reversalCommandLabels, reversalCommandSchema, reversalFailureCodes, reversalOperationViewerPermissions, reversalReasonCodeSchema, type ReversalCommand } from "../domain/intake-reversal.policy.js";
import { CaseReviewConflictError, ReversalApprovalRefusedError, ReversalNotCancellableError, type IntakeRepository, type IntakeReversalOperationRecord, type IntakeReversalSnapshot } from "../repository/intake.repository.js";

// The reversal write/read methods are optional on IntakeRepository (so the
// many test fake repositories don't have to stub them), but these services
// always run against a repository that implements them -- same
// Required<Pick<...>> pattern get-intake-workflow.service.ts already uses for
// getIntakeWorkflowSnapshot/listIntakeCaseHistory.
export type ReversalRepository = Required<
  Pick<
    IntakeRepository,
    "getIntakeReversalSnapshot" | "createReversalOperation" | "getReversalOperation" | "approveReversalOperation" | "cancelReversalOperation" | "executeReversalOperation"
  >
>;

function mapSnapshot(snapshot: IntakeReversalSnapshot) {
  return {
    stage: snapshot.stage,
    workflowEventSequence: snapshot.workflowEventSequence,
    latestTransition: snapshot.latestTransition,
    latestTransitionReversed: snapshot.latestTransitionReversed,
    activeInformationRequest: snapshot.activeInformationRequest,
    offering: snapshot.offering,
    legalExecutionCompleted: snapshot.legalExecutionCompleted,
    appraisalCompleted: snapshot.appraisalCompleted,
    correctionInProgress: snapshot.correctionInProgress,
  };
}

export class GetIntakeReversalPreviewService {
  public constructor(private readonly repository: ReversalRepository) {}

  // viewerAccountId is the staff account asking: what it may do with the pending operation depends on who it is.
  public async execute(caseId: string, viewerAccountId: string) {
    const snapshot = await this.repository.getIntakeReversalSnapshot(caseId);
    if (snapshot === null) throw new AppError({ code: "intake.case_not_found", title: "Case not found", status: 404, detail: "The intake case does not exist." });
    const actions = getReversalActions(snapshot);
    return {
      data: {
        case_id: snapshot.caseId,
        stage: snapshot.stage,
        workflow_event_sequence: snapshot.workflowEventSequence,
        latest_transition: snapshot.latestTransition === null ? null : { event_id: snapshot.latestTransition.eventId, from_stage: snapshot.latestTransition.fromStage, to_stage: snapshot.latestTransition.toStage },
        correction_in_progress: snapshot.correctionInProgress,
        pending_operation: snapshot.activeOperation === null ? null : toPendingOperation(snapshot.activeOperation, viewerAccountId),
        available: actions.length > 0,
        actions: actions.map((action) => ({ action: action.command, label: action.label, target_stage: action.targetStage, requires_reason: true, requires_second_approval: action.requiresSecondApproval, execution_mode: action.executionMode, impact_summary: action.impactSummary, blockers: action.blockers })),
      },
    };
  }
}

// What a second staff member needs to find and decide on the correction pausing the case. The viewer_* flags are the server's
// word on what this account may do, so a client never has to repeat the rules.
function toPendingOperation(operation: IntakeReversalOperationRecord, viewerAccountId: string) {
  const permissions = reversalOperationViewerPermissions(operation, viewerAccountId);
  return {
    operation_id: operation.operationId,
    command: operation.command,
    command_label: reversalCommandLabels[operation.command as ReversalCommand] ?? operation.command,
    from_stage: operation.fromStage,
    to_stage: operation.toStage,
    status: operation.status,
    reason_code: operation.reasonCode,
    reason: operation.reason,
    requested_by_account_id: operation.requestedByAccountId,
    requested_at: operation.createdAt.toISOString(),
    viewer_can_approve: permissions.canApprove,
    viewer_can_cancel: permissions.canCancel,
  };
}

function getReversalActions(snapshot: IntakeReversalSnapshot) {
  const commands: ReversalCommand[] = ["return_to_draft", "withdraw_information_request", "reopen_pre_offering", "reopen_structuring", "reopen_final_offering_review"];
  return commands.map((command) => getReversalAction(mapSnapshot(snapshot), command)).filter((action): action is NonNullable<typeof action> => action !== null);
}

export class RequestIntakeReversalService {
  public constructor(private readonly repository: ReversalRepository, private readonly clock: () => Date = () => new Date()) {}

  public async execute(input: { caseId: string; command: string; accountId: string; traceId: string; idempotencyKey: string; expectedStage: string; expectedWorkflowEventSequence: number; reasonCode: string; reason: string }) {
    const command = reversalCommandSchema.parse(input.command);
    const reasonCode = reversalReasonCodeSchema.parse(input.reasonCode);
    const snapshot = await this.repository.getIntakeReversalSnapshot(input.caseId);
    if (snapshot === null) throw new AppError({ code: "intake.case_not_found", title: "Case not found", status: 404, detail: "The intake case does not exist." });
    if (snapshot.stage !== input.expectedStage || snapshot.workflowEventSequence !== input.expectedWorkflowEventSequence) throw reversalConflictError();
    const action = getReversalAction(mapSnapshot(snapshot), command);
    if (action === null) throw reversalNotAllowedError();
    const operation = await mapRepositoryConflict(() => this.repository.createReversalOperation({ caseId: input.caseId, command, fromStage: snapshot.stage, toStage: action.targetStage, status: action.requiresSecondApproval ? "pending_approval" : "requested", reasonCode, reason: input.reason, requestedByAccountId: input.accountId, expectedStage: input.expectedStage, expectedWorkflowEventSequence: input.expectedWorkflowEventSequence, reversalOfEventId: snapshot.latestTransition?.eventId ?? null, idempotencyKey: input.idempotencyKey, traceId: input.traceId }));
    if (operation.status === "pending_approval") return { data: toOperationResponse(operation) };
    const completed = await mapRepositoryConflict(() => this.repository.executeReversalOperation({ caseId: input.caseId, operationId: operation.operationId, actorAccountId: input.accountId, traceId: input.traceId, completedAt: this.clock() }));
    return { data: toOperationResponse(requireNotFailed(completed ?? operation)) };
  }
}

export class ApproveIntakeReversalService {
  public constructor(private readonly repository: ReversalRepository, private readonly clock: () => Date = () => new Date()) {}

  public async execute(input: { caseId: string; operationId: string; accountId: string; traceId: string }) {
    const operation = await mapRepositoryConflict(() => mapApprovalRefusal(() => this.repository.approveReversalOperation({ caseId: input.caseId, operationId: input.operationId, approverAccountId: input.accountId, approvedAt: this.clock() })), "This correction cannot be approved right now.");
    if (operation === null) throw new AppError({ code: "intake.reversal_operation_not_found", title: "Correction not found", status: 404, detail: "The correction operation does not exist." });
    const completed = await mapRepositoryConflict(() => this.repository.executeReversalOperation({ caseId: input.caseId, operationId: input.operationId, actorAccountId: input.accountId, traceId: input.traceId, completedAt: this.clock() }));
    return { data: toOperationResponse(requireNotFailed(completed ?? operation)) };
  }
}

export class CancelIntakeReversalService {
  public constructor(private readonly repository: ReversalRepository, private readonly clock: () => Date = () => new Date()) {}

  // Either the requester or another staff member may call off a correction that has not been approved yet. Cancelling one that is
  // already cancelled returns it unchanged.
  public async execute(input: { caseId: string; operationId: string; accountId: string; traceId: string; note?: string | undefined }) {
    const operation = await mapRepositoryConflict(() => mapCancelRefusal(() => this.repository.cancelReversalOperation({ caseId: input.caseId, operationId: input.operationId, cancelledByAccountId: input.accountId, note: input.note ?? null, cancelledAt: this.clock(), traceId: input.traceId })));
    if (operation === null) throw new AppError({ code: "intake.reversal_operation_not_found", title: "Correction not found", status: 404, detail: "The correction operation does not exist." });
    return { data: toOperationResponse(operation) };
  }
}

export class GetIntakeReversalOperationService {
  public constructor(private readonly repository: ReversalRepository) {}
  public async execute(input: { caseId: string; operationId: string }) {
    const operation = await this.repository.getReversalOperation(input.caseId, input.operationId);
    if (operation === null) throw new AppError({ code: "intake.reversal_operation_not_found", title: "Correction not found", status: 404, detail: "The correction operation does not exist." });
    return { data: toOperationResponse(operation) };
  }
}

function reversalConflictError(detail = "The case changed while this correction was being prepared. Refresh and try again.", cause?: unknown) {
  return new AppError({ code: "intake.reversal_conflict", title: "Case changed", status: 409, detail, cause });
}

function reversalSelfApprovalForbiddenError(cause: unknown) {
  return new AppError({ code: "intake.reversal_self_approval_forbidden", title: "Approval by the requester not allowed", status: 403, detail: "You requested this correction, so another staff member has to approve it.", cause });
}

function reversalNotPendingApprovalError(cause: unknown) {
  return new AppError({ code: "intake.reversal_not_pending_approval", title: "Correction not awaiting approval", status: 409, detail: "This correction is not awaiting approval. Refresh to see its current state.", cause });
}

function reversalNotCancellableError(cause: unknown) {
  return new AppError({ code: "intake.reversal_not_cancellable", title: "Correction cannot be cancelled", status: 409, detail: "This correction can no longer be cancelled: it has been approved, has already run or has failed.", cause });
}

function reversalNotAllowedError() {
  return new AppError({ code: "intake.reversal_not_allowed", title: "Correction not allowed", status: 409, detail: "This case cannot be moved back from its current state." });
}

// The repository reports a conflict it detects under its own lock as a
// CaseReviewConflictError, which would otherwise reach the client as a 500.
async function mapRepositoryConflict<T>(action: () => Promise<T>, detail?: string): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CaseReviewConflictError) throw reversalConflictError(detail, error);
    throw error;
  }
}

// Tells the two reasons an approval is refused apart. The repository reports both as conflicts, but the client can only act on
// one of them (hand the correction to someone else), so each has its own code.
async function mapApprovalRefusal<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ReversalApprovalRefusedError) throw error.reason === "self_approval" ? reversalSelfApprovalForbiddenError(error) : reversalNotPendingApprovalError(error);
    throw error;
  }
}

async function mapCancelRefusal<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ReversalNotCancellableError) throw reversalNotCancellableError(error);
    throw error;
  }
}

// An operation that execution ended as failed did not change the case, so the
// caller is told why, in the same terms the request-time checks use.
function requireNotFailed(operation: IntakeReversalOperationRecord) {
  if (operation.status === "failed") throw operation.failureCode === reversalFailureCodes.notAllowed ? reversalNotAllowedError() : reversalConflictError();
  return operation;
}

function toOperationResponse(operation: IntakeReversalOperationRecord) {
  return {
    operation_id: operation.operationId,
    case_id: operation.caseId,
    command: operation.command,
    from_stage: operation.fromStage,
    to_stage: operation.toStage,
    status: operation.status,
    reason_code: operation.reasonCode,
    requested_by_account_id: operation.requestedByAccountId,
    approved_by_account_id: operation.approvedByAccountId,
    reversal_of_event_id: operation.reversalOfEventId,
    completed_at: operation.completedAt?.toISOString() ?? null,
    failed_at: operation.failedAt?.toISOString() ?? null,
    failure_code: operation.failureCode,
    failure_detail: operation.failureDetail,
  };
}

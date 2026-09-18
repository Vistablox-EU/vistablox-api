import { AppError } from "../../../shared/errors/app-error.js";
import { getReversalAction, reversalCommandSchema, reversalReasonCodeSchema, type ReversalCommand } from "../domain/intake-reversal.policy.js";
import type { IntakeRepository, IntakeReversalOperationRecord, IntakeReversalSnapshot } from "../repository/intake.repository.js";

function mapSnapshot(snapshot: IntakeReversalSnapshot) {
  return {
    stage: snapshot.stage,
    workflowEventSequence: snapshot.workflowEventSequence,
    latestTransition: snapshot.latestTransition,
    activeInformationRequest: snapshot.activeInformationRequest,
    offering: snapshot.offering,
    legalExecutionCompleted: snapshot.legalExecutionCompleted,
    appraisalCompleted: snapshot.appraisalCompleted,
    correctionInProgress: snapshot.correctionInProgress,
  };
}

export class GetIntakeReversalPreviewService {
  public constructor(private readonly repository: IntakeRepository) {}

  public async execute(caseId: string) {
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
        available: actions.length > 0,
        actions: actions.map((action) => ({ action: action.command, label: action.label, target_stage: action.targetStage, requires_reason: true, requires_second_approval: action.requiresSecondApproval, execution_mode: action.executionMode, impact_summary: action.impactSummary, blockers: action.blockers })),
      },
    };
  }
}

function getReversalActions(snapshot: IntakeReversalSnapshot) {
  const commands: ReversalCommand[] = ["return_to_draft", "withdraw_information_request", "reopen_pre_offering", "reopen_structuring", "reopen_final_offering_review"];
  return commands.map((command) => getReversalAction(mapSnapshot(snapshot), command)).filter((action): action is NonNullable<typeof action> => action !== null);
}

export class RequestIntakeReversalService {
  public constructor(private readonly repository: IntakeRepository, private readonly clock: () => Date = () => new Date()) {}

  public async execute(input: { caseId: string; command: string; accountId: string; traceId: string; idempotencyKey: string; expectedStage: string; expectedWorkflowEventSequence: number; reasonCode: string; reason: string }) {
    const command = reversalCommandSchema.parse(input.command);
    const reasonCode = reversalReasonCodeSchema.parse(input.reasonCode);
    const snapshot = await this.repository.getIntakeReversalSnapshot(input.caseId);
    if (snapshot === null) throw new AppError({ code: "intake.case_not_found", title: "Case not found", status: 404, detail: "The intake case does not exist." });
    if (snapshot.stage !== input.expectedStage || snapshot.workflowEventSequence !== input.expectedWorkflowEventSequence) throw new AppError({ code: "intake.reversal_conflict", title: "Case changed", status: 409, detail: "The case changed while this correction was being prepared. Refresh and try again." });
    const action = getReversalAction(mapSnapshot(snapshot), command);
    if (action === null) throw new AppError({ code: "intake.reversal_not_allowed", title: "Correction not allowed", status: 409, detail: "This case cannot be moved back from its current state." });
    const operation = await this.repository.createReversalOperation({ caseId: input.caseId, command, fromStage: snapshot.stage, toStage: action.targetStage, status: action.requiresSecondApproval ? "pending_approval" : "requested", reasonCode, reason: input.reason, requestedByAccountId: input.accountId, expectedStage: input.expectedStage, expectedWorkflowEventSequence: input.expectedWorkflowEventSequence, reversalOfEventId: snapshot.latestTransition?.eventId ?? null, idempotencyKey: input.idempotencyKey, traceId: input.traceId });
    if (operation.status === "pending_approval") return { data: toOperationResponse(operation) };
    const completed = await this.repository.executeReversalOperation({ caseId: input.caseId, operationId: operation.operationId, actorAccountId: input.accountId, traceId: input.traceId, completedAt: this.clock() });
    return { data: toOperationResponse(completed ?? operation) };
  }
}

export class ApproveIntakeReversalService {
  public constructor(private readonly repository: IntakeRepository, private readonly clock: () => Date = () => new Date()) {}

  public async execute(input: { caseId: string; operationId: string; accountId: string; traceId: string }) {
    const operation = await this.repository.approveReversalOperation({ caseId: input.caseId, operationId: input.operationId, approverAccountId: input.accountId, approvedAt: this.clock() });
    if (operation === null) throw new AppError({ code: "intake.reversal_operation_not_found", title: "Correction not found", status: 404, detail: "The correction operation does not exist." });
    const completed = await this.repository.executeReversalOperation({ caseId: input.caseId, operationId: input.operationId, actorAccountId: input.accountId, traceId: input.traceId, completedAt: this.clock() });
    return { data: toOperationResponse(completed ?? operation) };
  }
}

export class GetIntakeReversalOperationService {
  public constructor(private readonly repository: IntakeRepository) {}
  public async execute(input: { caseId: string; operationId: string }) {
    const operation = await this.repository.getReversalOperation(input.caseId, input.operationId);
    if (operation === null) throw new AppError({ code: "intake.reversal_operation_not_found", title: "Correction not found", status: 404, detail: "The correction operation does not exist." });
    return { data: toOperationResponse(operation) };
  }
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

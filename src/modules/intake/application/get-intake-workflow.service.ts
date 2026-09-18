import { AppError } from "../../../shared/errors/app-error.js";
import { getIntakeWorkflowForStage, intakeCaseStageValues } from "../domain/intake-workflow.catalog.js";
import type { GetOperationsReadinessService } from "./get-operations-readiness.service.js";
import type { IntakeCaseHistoryEvent, IntakeRepository, IntakeWorkflowSnapshot } from "../repository/intake.repository.js";

type WorkflowReadRepository = Pick<Required<IntakeRepository>, "getIntakeWorkflowSnapshot" | "listIntakeCaseHistory">;

const eventLabels: Record<string, string> = {
  case_created: "Case created",
  case_submitted: "Case submitted",
  case_resubmitted: "Case resubmitted",
  founder_decision_recorded: "Founder decision recorded",
  case_information_requested: "Information requested",
  case_information_request_expired: "Information request expired",
  case_rejected: "Case rejected",
  case_withdrawn: "Case withdrawn",
  case_expired: "Case expired",
  case_post_ipo_structuring_started: "Post-IPO structuring started",
  case_approved_for_final_offering: "Approved for final offering",
  offering_created: "Offering created",
  offering_disclosure_pack_published: "Disclosure pack published",
  offering_final_terms_published: "Final offering terms published",
  offering_finalized: "Offering finalized",
  handoff_queued: "Workflow handoff queued",
  handoff_started: "Workflow handoff started",
  handoff_succeeded: "Workflow handoff completed",
  handoff_failed: "Workflow handoff failed",
  case_information_request_withdrawn: "Information request withdrawn",
  case_evidence_reviewed: "Evidence reviewed",
  partner_assignment_changed: "Partner assignment changed",
  legal_structuring_updated: "Legal structuring updated",
  appraisal_updated: "Appraisal updated",
  room_photo_uploaded: "Room photo uploaded",
  room_photo_representative_selected: "Representative room photo selected",
  room_photo_deleted: "Room photo deleted",
  room_deleted: "Room removed",
  offering_funding_target_reached: "Funding target reached",
  offering_funding_target_no_longer_met: "Funding target no longer met",
  offering_reconfirmation_window_opened: "Reconfirmation window opened",
  offering_reconfirmation_window_closed: "Reconfirmation window closed",
};
const actionLabels: Record<string, string> = {
  review_evidence: "Review evidence",
  request_information: "Request information",
  record_founder_decision: "Record founder decision",
  assign_partner: "Assign partner",
  publish_disclosure_pack: "Publish disclosure pack",
  publish_final_offering_terms: "Publish final offering terms",
  retry_post_ipo_handoff: "Retry post-IPO handoff",
  close_case: "Close case",
};

function caseNotFoundError() {
  return new AppError({
    code: "intake.case_not_found",
    title: "Intake case not found",
    status: 404,
    detail: "The requested intake case does not exist.",
  });
}

export function encodeHistoryCursor(event: IntakeCaseHistoryEvent) {
  return Buffer.from(JSON.stringify({ occurred_at: event.occurredAt.toISOString(), event_id: event.eventId }), "utf8").toString("base64url");
}

export function decodeHistoryCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { occurred_at?: unknown; event_id?: unknown };
    if (typeof parsed.occurred_at !== "string" || typeof parsed.event_id !== "string") throw new Error("invalid cursor");
    const occurredAt = new Date(parsed.occurred_at);
    if (Number.isNaN(occurredAt.getTime())) throw new Error("invalid cursor");
    return { occurredAt, eventId: parsed.event_id };
  } catch {
    throw new AppError({ code: "intake.invalid_history_cursor", title: "Invalid history cursor", status: 400, detail: "The history cursor is invalid." });
  }
}

function workflowState(snapshot: IntakeWorkflowSnapshot, workflowType: string) {
  const activeRequest = snapshot.informationRequests.find((request) => request.status === "published") ?? null;
  const base = {
    current_revision_number: snapshot.currentRevisionNumber,
    active_information_request: activeRequest === null ? null : {
      request_id: activeRequest.requestId,
      status: activeRequest.status,
      published_at: activeRequest.publishedAt?.toISOString() ?? null,
      due_at: activeRequest.dueAt?.toISOString() ?? null,
    },
    information_request_count: snapshot.informationRequests.length,
    workflow_type: workflowType,
  };
  if (workflowType === "ipo" || workflowType === "final_offering") {
    return {
      ...base,
      reviewed_by_account_id: snapshot.reviewedByAccountId,
      approved_at: snapshot.approvedAt?.toISOString() ?? null,
      ipo_period_days: snapshot.ipoPeriodDays,
      ipo_end_at: snapshot.ipoEndAt?.toISOString() ?? null,
      ipo_value_eur: snapshot.ipoValueEur,
      offering: snapshot.offering === null ? null : {
        offering_id: snapshot.offering.offeringId,
        status: snapshot.offering.status,
        target_raise_eur: snapshot.offering.targetRaiseEur,
        final_offering_published_at: snapshot.offering.finalOfferingPublishedAt?.toISOString() ?? null,
      },
    };
  }
  if (workflowType === "post_ipo_structuring") {
    return {
      ...base,
      legal_practice_id: snapshot.legalPracticeId,
      appraisal_firm_id: snapshot.appraisalFirmId,
      legal_structuring_completed_at: snapshot.legalStructuringCompletedAt?.toISOString() ?? null,
      appraisal_completed_at: snapshot.appraisalCompletedAt?.toISOString() ?? null,
      post_ipo_structuring_completed_at: snapshot.postIpoStructuringCompletedAt?.toISOString() ?? null,
    };
  }
  if (workflowType === "terminal") {
    return {
      ...base,
      rejected_at: snapshot.rejectedAt?.toISOString() ?? null,
      rejection_reason_code: snapshot.rejectionReasonCode,
    };
  }
  return base;
}

export class GetIntakeWorkflowService {
  public constructor(
    private readonly repository: WorkflowReadRepository,
    private readonly readiness?: GetOperationsReadinessService,
  ) {}

  public async execute(caseId: string) {
    const snapshot = await this.repository.getIntakeWorkflowSnapshot(caseId);
    if (snapshot === null) throw caseNotFoundError();
    const workflow = getIntakeWorkflowForStage(snapshot.stage);
    const readiness = this.readiness === undefined ? null : await this.readiness.execute(caseId);
    return {
      data: {
        case_id: snapshot.caseId,
        stage: snapshot.stage,
        stage_label: workflow.label,
        workflow_type: workflow.type,
        workflow_version: 1,
        terminal: workflow.terminal,
        stage_sequence: intakeCaseStageValues.map((stage) => ({
          stage,
          label: getIntakeWorkflowForStage(stage).label,
        })),
        created_at: snapshot.createdAt.toISOString(),
        updated_at: snapshot.updatedAt.toISOString(),
        workflow: workflowState(snapshot, workflow.type),
        allowed_actions: readiness?.data.allowed_next_actions ?? [],
        allowed_action_labels: (readiness?.data.allowed_next_actions ?? []).map((action) => actionLabels[action] ?? action),
        blockers: readiness?.data.blockers ?? [],
      },
    };
  }
}

export class GetIntakeCaseHistoryService {
  public constructor(private readonly repository: WorkflowReadRepository) {}

  public async execute(input: { caseId: string; limit: number; after?: string }) {
    const exists = await this.repository.getIntakeWorkflowSnapshot(input.caseId);
    if (exists === null) throw caseNotFoundError();
    const page = await this.repository.listIntakeCaseHistory({
      caseId: input.caseId,
      limit: input.limit,
      ...(input.after === undefined ? {} : { after: decodeHistoryCursor(input.after) }),
    });
    return {
      data: page.events.map((event) => ({
        event_id: event.eventId,
        event_sequence: event.eventSequence,
        event_type: event.eventType,
        event_label: eventLabels[event.eventType] ?? event.eventType,
        workflow_type: event.workflowType,
        workflow_version: event.workflowVersion,
        occurred_at: event.occurredAt.toISOString(),
        actor: { type: event.actorType, account_id: event.actorAccountId },
        stage_transition: event.fromStage === null || event.toStage === null ? null : {
          from: event.fromStage,
          from_label: getIntakeWorkflowForStage(event.fromStage).label,
          to: event.toStage,
          to_label: getIntakeWorkflowForStage(event.toStage).label,
        },
        related_resource: event.relatedResourceType === null || event.relatedResourceId === null ? null : {
          type: event.relatedResourceType,
          id: event.relatedResourceId,
        },
        source: event.eventSource,
        details: event.metadata,
      })),
      page: {
        next_cursor: page.hasNextPage && page.events.at(-1) !== undefined ? encodeHistoryCursor(page.events.at(-1)!) : null,
      },
    };
  }
}

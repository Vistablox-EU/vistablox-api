import { z } from "zod";

export const reversalReasonCodeSchema = z.enum([
  "operator_input_error",
  "wrong_case_selected",
  "duplicate_case",
  "missing_evidence_correction",
  "partner_assignment_correction",
  "founder_decision_correction",
  "offering_setup_correction",
  "compliance_directed_correction",
  "system_recovery",
]);

export const reversalCommandSchema = z.enum([
  "return_to_draft",
  "withdraw_information_request",
  "reopen_pre_offering",
  "reopen_structuring",
  "reopen_final_offering_review",
]);

export type ReversalCommand = z.infer<typeof reversalCommandSchema>;

// What staff see for each command. The preview's available actions and the
// pending operation both use it, so an operation keeps its label while it
// blocks the case (when no action is available).
export const reversalCommandLabels: Record<ReversalCommand, string> = {
  return_to_draft: "Return to draft",
  withdraw_information_request: "Withdraw information request",
  reopen_pre_offering: "Reopen review",
  reopen_structuring: "Reopen structuring",
  reopen_final_offering_review: "Reopen final-offering review",
};

// An operation in one of these statuses is a correction in progress: it pauses
// the case and blocks every other correction until it ends.
export const activeReversalStatuses = ["requested", "pending_approval", "approved", "executing"] as const;

// Only an operation that has not been approved yet can be called off. Once
// approved, it is on its way to execution (and its approver can still finish it).
export const cancellableReversalStatuses = ["requested", "pending_approval"] as const;

export type ReversalApprovalRefusal = "not_pending_approval" | "self_approval";

// Why this account cannot approve the operation, or null when it can. Status
// comes first: an operation that is not waiting for approval says so whoever
// asks, and only one that is waiting turns the requester away as such.
export function reversalApprovalRefusal(
  operation: { status: string; requestedByAccountId: string },
  approverAccountId: string,
): ReversalApprovalRefusal | null {
  if (operation.status !== "pending_approval") return "not_pending_approval";
  if (operation.requestedByAccountId === approverAccountId) return "self_approval";
  return null;
}

// An approval that committed but whose execution never ran (the process died in
// between) is finished by the account that gave it, by approving again. Nobody
// else can: the operation is no longer awaiting approval, and it is past cancelling.
export function canFinishClaimedApproval(
  operation: { status: string; approvedByAccountId: string | null },
  accountId: string,
): boolean {
  return operation.status === "approved" && operation.approvedByAccountId === accountId;
}

// What the viewing account may do with an active operation. Cancelling is open
// to the requester and to anyone else with access: a wrong request must be
// possible to withdraw, and a second person to decline it. "Approve" also covers
// finishing an approval the viewer already gave, which the API accepts, so that
// a client driven by this flag is not left with a case it cannot unpause.
export function reversalOperationViewerPermissions(
  operation: { status: string; requestedByAccountId: string; approvedByAccountId: string | null },
  viewerAccountId: string,
): { canApprove: boolean; canCancel: boolean } {
  return {
    canApprove: reversalApprovalRefusal(operation, viewerAccountId) === null || canFinishClaimedApproval(operation, viewerAccountId),
    canCancel: (cancellableReversalStatuses as readonly string[]).includes(operation.status),
  };
}

// Why an operation ended in `failed`, as stored in failure_code. case_changed:
// the case's stage or workflow sequence moved after the request. not_allowed:
// the policy no longer allows the command at execution (a blocker appeared), or
// no executor exists for it. execution_error: an unexpected error during
// execution.
export const reversalFailureCodes = {
  caseChanged: "case_changed",
  notAllowed: "not_allowed",
  executionError: "execution_error",
} as const;

export interface ReversalSnapshot {
  stage: string;
  workflowEventSequence: number;
  latestTransition: { eventId: string; fromStage: string; toStage: string } | null;
  // Every correction is recorded against the latest transition, and the ledger
  // allows an event to be reversed only once.
  latestTransitionReversed: boolean;
  activeInformationRequest: boolean;
  offering: {
    offeringId: string;
    status: string;
    finalOfferingPublishedAt: Date | null;
    reservationCount: number;
    fundedReservationCount: number;
    disclosurePackPublished: boolean;
    reconfirmationOpen: boolean;
    finalizedReservationCount: number;
  } | null;
  legalExecutionCompleted: boolean;
  appraisalCompleted: boolean;
  correctionInProgress: boolean;
}

export interface ReversalAction {
  command: ReversalCommand;
  targetStage: string;
  label: string;
  requiresSecondApproval: boolean;
  executionMode: "synchronous" | "asynchronous";
  impactSummary: string;
  blockers: string[];
}

const terminalStages = new Set(["rejected", "withdrawn", "expired"]);

export function evaluateReversalActions(snapshot: ReversalSnapshot): ReversalAction[] {
  if (snapshot.correctionInProgress || snapshot.latestTransitionReversed || terminalStages.has(snapshot.stage)) return [];
  const actions: ReversalAction[] = [];
  if (snapshot.stage === "submitted" && snapshot.latestTransition?.toStage === "submitted" && !snapshot.activeInformationRequest && snapshot.offering === null) {
    actions.push({ command: "return_to_draft", targetStage: "draft", label: reversalCommandLabels.return_to_draft, requiresSecondApproval: false, executionMode: "synchronous", impactSummary: "The current submission is preserved and the case returns to draft for correction.", blockers: [] });
  }
  if (snapshot.stage === "waiting_on_applicant" && snapshot.activeInformationRequest) {
    actions.push({ command: "withdraw_information_request", targetStage: "submitted", label: reversalCommandLabels.withdraw_information_request, requiresSecondApproval: false, executionMode: "synchronous", impactSummary: "The active request will be withdrawn and the case returns to review.", blockers: [] });
  }
  if (snapshot.stage === "pre_offering_open") {
    const blockers = snapshot.offering === null ? ["offering_missing"] : [
      ...(snapshot.offering.reservationCount > 0 ? ["reservations_exist"] : []),
      ...(snapshot.offering.fundedReservationCount > 0 ? ["funding_exists"] : []),
      ...(snapshot.offering.disclosurePackPublished ? ["disclosure_pack_published"] : []),
      ...(snapshot.offering.finalOfferingPublishedAt !== null ? ["final_terms_published"] : []),
      ...(snapshot.offering.reconfirmationOpen ? ["reconfirmation_open"] : []),
      ...(snapshot.offering.finalizedReservationCount > 0 ? ["offering_finalized"] : []),
    ];
    actions.push({ command: "reopen_pre_offering", targetStage: "submitted", label: reversalCommandLabels.reopen_pre_offering, requiresSecondApproval: true, executionMode: "asynchronous", impactSummary: "The provisional offering will be suspended and the case returns to founder review.", blockers });
  }
  if (snapshot.stage === "post_ipo_structuring") {
    const blockers = [
      ...(snapshot.offering !== null && snapshot.offering.finalOfferingPublishedAt !== null ? ["final_terms_published"] : []),
      ...(snapshot.offering !== null && snapshot.offering.reconfirmationOpen ? ["reconfirmation_open"] : []),
      ...((snapshot.offering?.finalizedReservationCount ?? 0) > 0 ? ["offering_finalized"] : []),
      ...(snapshot.legalExecutionCompleted ? ["legal_execution_completed"] : []),
      ...(snapshot.appraisalCompleted ? ["appraisal_completed"] : []),
    ];
    actions.push({ command: "reopen_structuring", targetStage: "pre_offering_open", label: reversalCommandLabels.reopen_structuring, requiresSecondApproval: true, executionMode: "asynchronous", impactSummary: "Partner completion will be reopened and the case returns to the IPO workflow.", blockers });
  }
  if (snapshot.stage === "approved_for_final_offering") {
    const blockers = [
      ...(snapshot.offering !== null && snapshot.offering.finalOfferingPublishedAt !== null ? ["final_terms_published"] : []),
      ...(snapshot.offering !== null && snapshot.offering.reconfirmationOpen ? ["reconfirmation_open"] : []),
      ...((snapshot.offering?.finalizedReservationCount ?? 0) > 0 ? ["offering_finalized"] : []),
    ];
    actions.push({ command: "reopen_final_offering_review", targetStage: "post_ipo_structuring", label: reversalCommandLabels.reopen_final_offering_review, requiresSecondApproval: true, executionMode: "asynchronous", impactSummary: "Structuring completion will be reopened before final terms publication.", blockers });
  }
  return actions.filter((action) => action.blockers.length === 0);
}

export function getReversalAction(snapshot: ReversalSnapshot, command: ReversalCommand): ReversalAction | null {
  return evaluateReversalActions(snapshot).find((action) => action.command === command) ?? null;
}

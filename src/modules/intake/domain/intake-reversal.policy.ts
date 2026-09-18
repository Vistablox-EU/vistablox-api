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

export interface ReversalSnapshot {
  stage: string;
  workflowEventSequence: number;
  latestTransition: { eventId: string; fromStage: string; toStage: string } | null;
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
  if (snapshot.correctionInProgress || terminalStages.has(snapshot.stage)) return [];
  const actions: ReversalAction[] = [];
  if (snapshot.stage === "submitted" && snapshot.latestTransition?.toStage === "submitted" && !snapshot.activeInformationRequest && snapshot.offering === null) {
    actions.push({ command: "return_to_draft", targetStage: "draft", label: "Return to draft", requiresSecondApproval: false, executionMode: "synchronous", impactSummary: "The current submission is preserved and the case returns to draft for correction.", blockers: [] });
  }
  if (snapshot.stage === "waiting_on_applicant" && snapshot.activeInformationRequest) {
    actions.push({ command: "withdraw_information_request", targetStage: "submitted", label: "Withdraw information request", requiresSecondApproval: false, executionMode: "synchronous", impactSummary: "The active request will be withdrawn and the case returns to review.", blockers: [] });
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
    actions.push({ command: "reopen_pre_offering", targetStage: "submitted", label: "Reopen review", requiresSecondApproval: true, executionMode: "asynchronous", impactSummary: "The provisional offering will be suspended and the case returns to founder review.", blockers });
  }
  if (snapshot.stage === "post_ipo_structuring") {
    const blockers = [
      ...(snapshot.offering !== null && snapshot.offering.finalOfferingPublishedAt !== null ? ["final_terms_published"] : []),
      ...(snapshot.offering !== null && snapshot.offering.reconfirmationOpen ? ["reconfirmation_open"] : []),
      ...((snapshot.offering?.finalizedReservationCount ?? 0) > 0 ? ["offering_finalized"] : []),
      ...(snapshot.legalExecutionCompleted ? ["legal_execution_completed"] : []),
      ...(snapshot.appraisalCompleted ? ["appraisal_completed"] : []),
    ];
    actions.push({ command: "reopen_structuring", targetStage: "pre_offering_open", label: "Reopen structuring", requiresSecondApproval: true, executionMode: "asynchronous", impactSummary: "Partner completion will be reopened and the case returns to the IPO workflow.", blockers });
  }
  if (snapshot.stage === "approved_for_final_offering") {
    const blockers = [
      ...(snapshot.offering !== null && snapshot.offering.finalOfferingPublishedAt !== null ? ["final_terms_published"] : []),
      ...(snapshot.offering !== null && snapshot.offering.reconfirmationOpen ? ["reconfirmation_open"] : []),
      ...((snapshot.offering?.finalizedReservationCount ?? 0) > 0 ? ["offering_finalized"] : []),
    ];
    actions.push({ command: "reopen_final_offering_review", targetStage: "post_ipo_structuring", label: "Reopen final-offering review", requiresSecondApproval: true, executionMode: "asynchronous", impactSummary: "Structuring completion will be reopened before final terms publication.", blockers });
  }
  return actions.filter((action) => action.blockers.length === 0);
}

export function getReversalAction(snapshot: ReversalSnapshot, command: ReversalCommand): ReversalAction | null {
  return evaluateReversalActions(snapshot).find((action) => action.command === command) ?? null;
}

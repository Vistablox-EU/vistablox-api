import { z } from "zod";

export const intakeCaseStageValues = [
  "draft", "submitted", "waiting_on_applicant", "pre_offering_open",
  "post_ipo_structuring", "approved_for_final_offering", "rejected", "withdrawn", "expired",
] as const;
export const intakeWorkflowStageSchema = z.enum(intakeCaseStageValues);

export const intakeWorkflowTypeSchema = z.enum([
  "draft_submission",
  "operations_review",
  "applicant_information",
  "ipo",
  "post_ipo_structuring",
  "final_offering",
  "terminal",
]);

export type IntakeWorkflowType = z.infer<typeof intakeWorkflowTypeSchema>;

export const intakeWorkflowCatalog = {
  draft: { type: "draft_submission", label: "Draft submission", terminal: false },
  submitted: { type: "operations_review", label: "Operations review", terminal: false },
  waiting_on_applicant: { type: "applicant_information", label: "Applicant information", terminal: false },
  pre_offering_open: { type: "ipo", label: "IPO", terminal: false },
  post_ipo_structuring: { type: "post_ipo_structuring", label: "Post-IPO structuring", terminal: false },
  approved_for_final_offering: { type: "final_offering", label: "Final offering", terminal: false },
  rejected: { type: "terminal", label: "Rejected", terminal: true },
  withdrawn: { type: "terminal", label: "Withdrawn", terminal: true },
  expired: { type: "terminal", label: "Expired", terminal: true },
} as const satisfies Record<z.infer<typeof intakeWorkflowStageSchema>, { type: IntakeWorkflowType; label: string; terminal: boolean }>;

export function getIntakeWorkflowForStage(stage: string) {
  const parsed = intakeWorkflowStageSchema.parse(stage);
  return intakeWorkflowCatalog[parsed];
}

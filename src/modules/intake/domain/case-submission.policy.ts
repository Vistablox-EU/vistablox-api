export const requiredInitialEvidenceTypes = [
  "ownership_declaration",
  "property_facts_sheet",
  "encumbrance_declaration",
  "photo_set",
] as const;

// Closed document vocabulary shared by submission validation and staff
// uploads. Keeping this in the pure domain layer prevents API/infrastructure
// code from accepting references the submit policy can never use.
export const submissionEvidenceTypes = [
  ...requiredInitialEvidenceTypes,
  "registry_extract",
  "title_instrument",
  "cadastral_map",
  "power_of_attorney",
  "name_change_evidence",
  "occupancy_evidence",
  "succession_evidence",
] as const;

export type CaseSubmissionDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "invalid_stage" | "already_has_revision" | "missing_evidence" | "duplicate_evidence";
      missingEvidence?: string[];
    };

export function evaluateInitialCaseSubmission(input: {
  stage: string;
  hasCurrentRevision: boolean;
  documentTypes: string[];
}): CaseSubmissionDecision {
  if (input.stage !== "draft") {
    return { allowed: false, reason: "invalid_stage" };
  }
  if (input.hasCurrentRevision) {
    return { allowed: false, reason: "already_has_revision" };
  }

  return evaluateRequiredEvidence(input.documentTypes);
}

export function evaluateCaseResubmission(input: {
  stage: string;
  hasCurrentRevision: boolean;
  requestStatus: string;
  documentTypes: string[];
}): CaseSubmissionDecision {
  if (input.stage !== "waiting_on_applicant" || !input.hasCurrentRevision) {
    return { allowed: false, reason: "invalid_stage" };
  }
  if (input.requestStatus !== "published") {
    return { allowed: false, reason: "invalid_stage" };
  }
  return evaluateRequiredEvidence(input.documentTypes);
}

function evaluateRequiredEvidence(documentTypes: string[]): CaseSubmissionDecision {
  const uniqueTypes = new Set(documentTypes);
  if (uniqueTypes.size !== documentTypes.length) {
    return { allowed: false, reason: "duplicate_evidence" };
  }
  const missingEvidence = requiredInitialEvidenceTypes.filter(
    (requiredType) => !uniqueTypes.has(requiredType),
  );
  if (missingEvidence.length > 0) {
    return { allowed: false, reason: "missing_evidence", missingEvidence };
  }
  return { allowed: true };
}

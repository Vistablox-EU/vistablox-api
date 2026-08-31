export type PublishInformationRequestDecision =
  | { allowed: true }
  | { allowed: false; reason: "invalid_stage" | "missing_revision" | "active_request_exists" };

export function evaluateInformationRequestPublication(input: {
  stage: string;
  hasCurrentRevision: boolean;
  hasActiveRequest: boolean;
}): PublishInformationRequestDecision {
  if (input.stage !== "submitted") return { allowed: false, reason: "invalid_stage" };
  if (!input.hasCurrentRevision) return { allowed: false, reason: "missing_revision" };
  if (input.hasActiveRequest) return { allowed: false, reason: "active_request_exists" };
  return { allowed: true };
}

export type FounderDecision = "approve" | "reject";

export function canRecordFounderDecision(input: {
  stage: string;
  hasCurrentRevision: boolean;
}): boolean {
  return input.stage === "submitted" && input.hasCurrentRevision;
}

export function addBusinessDays(start: Date, businessDays: number): Date {
  if (!Number.isInteger(businessDays) || businessDays < 1) {
    throw new Error("Business-day duration must be a positive integer");
  }

  const result = new Date(start);
  let remaining = businessDays;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return result;
}

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

export function isInformationRequestOverdue(input: { dueAt: Date; now: Date }): boolean {
  return input.dueAt.getTime() < input.now.getTime();
}

// AD-193's day-3/day-7 cadence: a reminder is due on the UTC calendar day that
// exactly matches one of the configured elapsed-business-day milestones from
// publication. The scheduled job runs at most once a day, so this alone is
// enough to send each milestone exactly once with no separate "sent" marker.
export function isApplicantReminderDue(input: {
  publishedAt: Date;
  today: Date;
  reminderBusinessDays: number[];
}): boolean {
  return input.reminderBusinessDays.some((days) =>
    isSameUtcDate(addBusinessDays(input.publishedAt, days), input.today),
  );
}

function isSameUtcDate(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

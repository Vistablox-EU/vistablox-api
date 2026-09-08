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

// REAL_ESTATE_INTAKE_LIFECYCLE.md's state diagram, not PERMISSION_MATRIX.md's
// shorthand "at any stage": withdrawn is reachable from every pre-terminal
// stage up to (and including) an open pre-offering; rejected has exactly one
// path here distinct from the submitted-stage initial review this module
// already handles (RecordFounderDecisionService) — "ipo_period ends
// underfunded, founder closes the case". expired has no manual path at all;
// it's already fully automatic (ExpireOverdueInformationRequestsService).
export type CaseClosureOutcome = "withdrawn" | "rejected";

const closableFromStage: Record<CaseClosureOutcome, ReadonlySet<string>> = {
  withdrawn: new Set(["draft", "submitted", "waiting_on_applicant", "pre_offering_open"]),
  rejected: new Set(["pre_offering_open"]),
};

export function canCloseCase(input: { stage: string; outcome: CaseClosureOutcome }): boolean {
  return closableFromStage[input.outcome].has(input.stage);
}

// AD-166/PERMISSION_MATRIX.md: "Assign a Post-IPO structuring case to a
// legal practice / appraisal firm" -- reachable from the moment a case
// enters post_ipo_structuring, and still reassignable afterward, since
// completing approved_for_final_offering doesn't cut off correcting an
// assignment. Never earlier: legal/appraisal partners have no role at all
// before a case's funding is fully collected (AD-244/AD-248).
const partnerAssignableStages = new Set(["post_ipo_structuring", "approved_for_final_offering"]);

export function canAssignPartnerOrganization(input: { stage: string }): boolean {
  return partnerAssignableStages.has(input.stage);
}

// PERMISSION_MATRIX.md's Partner Writeback Allowlist: narrower than
// canAssignPartnerOrganization above -- writeback closes once a case has
// already moved on to approved_for_final_offering (both sides already
// complete), unlike assignment/reassignment, which the founder can still
// redo at that later stage.
export function canRecordPartnerWriteback(input: { stage: string }): boolean {
  return input.stage === "post_ipo_structuring";
}

// CORE_TABLES.md's post_ipo_structuring_completed_at comment: "set once
// both legal_structuring_completed_at and appraisal_completed_at are set;
// stage moves post_ipo_structuring -> approved_for_final_offering in the
// same action". This is a system-computed side effect of whichever
// partner's writeback happens to complete second, not a founder decision
// (PERMISSION_MATRIX.md's "only admin/operations moves stage" is about
// stage as someone's own direct action, not this automatic consequence).
export function isPostIpoStructuringComplete(input: {
  legalStructuringCompletedAt: Date | null;
  appraisalCompletedAt: Date | null;
}): boolean {
  return input.legalStructuringCompletedAt !== null && input.appraisalCompletedAt !== null;
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

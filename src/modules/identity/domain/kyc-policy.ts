export const diditStatuses = [
  "Not Started",
  "In Progress",
  "In Review",
  "Approved",
  "Declined",
  "Resubmitted",
  "Expired",
  "Abandoned",
  "Kyc Expired",
  "Awaiting User",
] as const;

export type DiditStatus = (typeof diditStatuses)[number];

export type KycEligibilityState =
  | "not_started"
  | "in_progress"
  | "pending_manual_review"
  | "eligible"
  | "unsupported_jurisdiction"
  | "not_eligible"
  | "requires_renewal"
  | "suspended_restricted";

export type KycOperationalSubstatus =
  | "kyc_not_started"
  | "kyc_session_creating"
  | "kyc_session_creation_failed"
  | "kyc_session_open"
  | "kyc_pending"
  | "kyc_resubmission_pending"
  | "kyc_manual_review"
  | "kyc_verified_pending_policy_eval"
  | "kyc_verified"
  | "kyc_verified_owner_poa_missing"
  | "kyc_jurisdiction_blocked"
  | "kyc_failed"
  | "kyc_restart_required"
  | "kyc_reverification_required"
  | "kyc_restricted"
  | "kyc_integration_anomaly";

export interface DiditWarningSummary {
  risk: string | null;
}

export interface DiditFeatureSummary {
  status: string;
  warnings: DiditWarningSummary[];
}

export interface DiditIdentitySummary extends DiditFeatureSummary {
  dateOfBirth: string | null;
}

export interface DiditAmlSummary extends DiditFeatureSummary {
  totalHits: number | null;
}

export interface DiditProofOfAddressSummary extends DiditFeatureSummary {
  issueDate: string | null;
  countryCode: string | null;
}

export interface DiditVerifiedDisplayProfile {
  givenName: string;
  familyName: string;
  fullDisplayName: string;
}

export interface DiditDecisionSummary {
  sessionId: string;
  sessionKind: "user" | "business" | null;
  workflowId: string | null;
  vendorData: string | null;
  status: DiditStatus | null;
  idVerifications: DiditIdentitySummary[];
  livenessChecks: DiditFeatureSummary[];
  faceMatches: DiditFeatureSummary[];
  amlScreenings: DiditAmlSummary[];
  proofOfAddressVerifications: DiditProofOfAddressSummary[];
  verifiedDisplayProfile: DiditVerifiedDisplayProfile | null;
}

export interface KycPolicyOutcome {
  eligibilityState: KycEligibilityState;
  operationalSubstatus: KycOperationalSubstatus;
  reasonCode: string;
  lastVerifiedAt: Date | null;
  renewalDueAt: Date | null;
  everRequiredManualReview: boolean;
}

// The status/decision-driven part of KycPolicyOutcome, before the renewal
// interval (which depends on accumulated risk history, not just this one
// decision) is layered on by evaluateDiditOutcome below.
type StatusOutcome = Omit<KycPolicyOutcome, "everRequiredManualReview">;

const supportedCountries = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE",
  "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT",
  "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO",
]);

const manualReviewReasons = new Set([
  "ID_DOCUMENT_TAMPER_SUSPECTED",
  "BIOMETRIC_FACE_MISMATCH",
  "IDENTITY_DATA_MISMATCH",
  "AML_SANCTIONS_HIT",
  "AML_PEP_REVIEW",
  "AML_ADVERSE_MEDIA_REVIEW",
]);

// AD-213's sibling renewal-policy rule (KYC_WORKFLOW.md's Renewal Policy):
// 24 months for a low-risk supported-jurisdiction retail customer, 12 for
// one who has ever required manual review. everRequiredManualReview is the
// account's persisted history (input, from the caller's last-read record);
// a status that itself resolves to kyc_manual_review on *this* decision
// also counts, so the flag going forward reflects it even before the next
// persisted read would.
export function evaluateDiditOutcome(input: {
  status: DiditStatus | null;
  decision: DiditDecisionSummary | null;
  residenceCountryCode: string | null;
  taxResidenceCountryCode: string | null;
  occurredAt: Date;
  everRequiredManualReview: boolean;
}): KycPolicyOutcome {
  const base = evaluateStatusOutcome(input);
  const everRequiredManualReview =
    input.everRequiredManualReview || base.operationalSubstatus === "kyc_manual_review";
  if (base.eligibilityState !== "eligible") {
    return { ...base, everRequiredManualReview };
  }
  const renewalDueAt = new Date(input.occurredAt);
  renewalDueAt.setUTCMonth(renewalDueAt.getUTCMonth() + (everRequiredManualReview ? 12 : 24));
  return { ...base, renewalDueAt, everRequiredManualReview };
}

function evaluateStatusOutcome(input: {
  status: DiditStatus | null;
  decision: DiditDecisionSummary | null;
  residenceCountryCode: string | null;
  taxResidenceCountryCode: string | null;
  occurredAt: Date;
}): StatusOutcome {
  switch (input.status) {
    case "Not Started":
      return outcome("not_started", "kyc_session_open", "KYC_SESSION_OPEN");
    case "In Progress":
      return outcome("in_progress", "kyc_pending", "KYC_SESSION_PENDING");
    case "Resubmitted":
      return outcome(
        "in_progress",
        "kyc_resubmission_pending",
        "KYC_RESUBMISSION_REQUIRED",
      );
    case "In Review":
      return outcome(
        "pending_manual_review",
        "kyc_manual_review",
        warningReason(input.decision, "KYC_MANUAL_REVIEW"),
      );
    case "Expired":
      return outcome("not_started", "kyc_restart_required", "KYC_SESSION_EXPIRED");
    case "Abandoned":
      return outcome("not_started", "kyc_restart_required", "KYC_SESSION_ABANDONED");
    case "Kyc Expired":
      return outcome(
        "requires_renewal",
        "kyc_reverification_required",
        "KYC_REVERIFICATION_REQUIRED",
      );
    case "Awaiting User":
    case null:
      return outcome(
        "pending_manual_review",
        "kyc_integration_anomaly",
        "PROVIDER_STATUS_ANOMALY",
      );
    case "Declined": {
      const reason = warningReason(input.decision, "ID_DOCUMENT_INVALID");
      return outcome(
        isManualReviewReason(reason)
          ? "pending_manual_review"
          : "not_eligible",
        isManualReviewReason(reason)
          ? "kyc_manual_review"
          : "kyc_failed",
        reason,
      );
    }
    case "Approved":
      return evaluateApproved(input);
  }
}

function evaluateApproved(input: {
  decision: DiditDecisionSummary | null;
  residenceCountryCode: string | null;
  taxResidenceCountryCode: string | null;
  occurredAt: Date;
}): StatusOutcome {
  if (
    input.residenceCountryCode === null ||
    input.taxResidenceCountryCode === null ||
    !supportedCountries.has(input.residenceCountryCode) ||
    !supportedCountries.has(input.taxResidenceCountryCode)
  ) {
    return outcome(
      "unsupported_jurisdiction",
      "kyc_jurisdiction_blocked",
      "JURISDICTION_UNSUPPORTED",
    );
  }
  const decision = input.decision;
  if (
    decision === null ||
    decision.idVerifications.length === 0 ||
    decision.livenessChecks.length === 0 ||
    decision.faceMatches.length === 0 ||
    decision.amlScreenings.length === 0
  ) {
    return outcome(
      "pending_manual_review",
      "kyc_integration_anomaly",
      "PROVIDER_STATUS_ANOMALY",
    );
  }

  const identityFailure = decision.idVerifications.find(
    (feature) => feature.status !== "Approved",
  );
  if (identityFailure !== undefined) {
    const reason = warningReasonFromFeatures([identityFailure], "ID_DOCUMENT_INVALID");
    return outcome(
      isManualReviewReason(reason) ? "pending_manual_review" : "not_eligible",
      isManualReviewReason(reason) ? "kyc_manual_review" : "kyc_failed",
      reason,
    );
  }
  if (decision.livenessChecks.some((feature) => feature.status !== "Approved")) {
    return outcome("not_eligible", "kyc_failed", "BIOMETRIC_LIVENESS_FAIL");
  }
  if (decision.faceMatches.some((feature) => feature.status !== "Approved")) {
    return outcome(
      "pending_manual_review",
      "kyc_manual_review",
      "BIOMETRIC_FACE_MISMATCH",
    );
  }
  if (
    decision.amlScreenings.some(
      (feature) => feature.status !== "Approved" || (feature.totalHits ?? 0) > 0,
    )
  ) {
    const reason = warningReasonFromFeatures(
      decision.amlScreenings,
      "AML_PEP_REVIEW",
    );
    return outcome("pending_manual_review", "kyc_manual_review", reason);
  }

  const datesOfBirth = decision.idVerifications
    .map((identity) => identity.dateOfBirth)
    .filter((value): value is string => value !== null);
  if (datesOfBirth.length === 0 || datesOfBirth.some((value) => !isAdult(value, input.occurredAt))) {
    return outcome(
      datesOfBirth.length === 0 ? "pending_manual_review" : "not_eligible",
      datesOfBirth.length === 0 ? "kyc_integration_anomaly" : "kyc_failed",
      datesOfBirth.length === 0 ? "PROVIDER_STATUS_ANOMALY" : "AGE_UNDER_18",
    );
  }

  return {
    eligibilityState: "eligible",
    operationalSubstatus: "kyc_verified_owner_poa_missing",
    reasonCode: "KYC_BASELINE_APPROVED",
    lastVerifiedAt: input.occurredAt,
    // Set by evaluateDiditOutcome, once it knows the account's full
    // manual-review history rather than just this one decision.
    renewalDueAt: null,
  };
}

// AD-213: the renewal job owns renewal_due_at end to end — an advance
// reminder on a configurable lead time, then an automatic transition to
// requires_renewal once the date passes. Both checks run at most once a day,
// so no separate "reminder already sent" marker is needed: isRenewalReminderDue
// matches exactly one calendar day, and the transition is naturally idempotent
// since a renewed/transitioned record no longer matches its own query.
export function isRenewalReminderDue(input: {
  renewalDueAt: Date;
  today: Date;
  leadDays: number;
}): boolean {
  const reminderDate = new Date(input.renewalDueAt);
  reminderDate.setUTCDate(reminderDate.getUTCDate() - input.leadDays);
  return (
    reminderDate.getUTCFullYear() === input.today.getUTCFullYear() &&
    reminderDate.getUTCMonth() === input.today.getUTCMonth() &&
    reminderDate.getUTCDate() === input.today.getUTCDate()
  );
}

export function isRenewalOverdue(input: { renewalDueAt: Date; now: Date }): boolean {
  return input.renewalDueAt.getTime() < input.now.getTime();
}

function outcome(
  eligibilityState: KycEligibilityState,
  operationalSubstatus: KycOperationalSubstatus,
  reasonCode: string,
): StatusOutcome {
  return {
    eligibilityState,
    operationalSubstatus,
    reasonCode,
    lastVerifiedAt: null,
    renewalDueAt: null,
  };
}

function warningReason(decision: DiditDecisionSummary | null, fallback: string): string {
  if (decision === null) return fallback;
  return warningReasonFromFeatures(
    [
      ...decision.idVerifications,
      ...decision.livenessChecks,
      ...decision.faceMatches,
      ...decision.amlScreenings,
    ],
    fallback,
  );
}

function warningReasonFromFeatures(
  features: DiditFeatureSummary[],
  fallback: string,
): string {
  const risks = features.flatMap((feature) =>
    feature.warnings.map((warning) => warning.risk?.toUpperCase() ?? ""),
  );
  if (risks.some((risk) => risk.includes("SANCTION"))) return "AML_SANCTIONS_HIT";
  if (risks.some((risk) => risk.includes("ADVERSE"))) return "AML_ADVERSE_MEDIA_REVIEW";
  if (risks.some((risk) => risk.includes("PEP"))) return "AML_PEP_REVIEW";
  if (risks.some((risk) => risk.includes("TAMPER"))) {
    return "ID_DOCUMENT_TAMPER_SUSPECTED";
  }
  if (risks.some((risk) => risk.includes("FACE") || risk.includes("MATCH"))) {
    return "BIOMETRIC_FACE_MISMATCH";
  }
  if (risks.some((risk) => risk.includes("LIVENESS"))) {
    return "BIOMETRIC_LIVENESS_FAIL";
  }
  if (risks.some((risk) => risk.includes("EXPIRED"))) return "ID_DOCUMENT_EXPIRED";
  return fallback;
}

function isManualReviewReason(reason: string): boolean {
  return manualReviewReasons.has(reason);
}

function isAdult(dateOfBirth: string, at: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return false;
  const [year, month, day] = dateOfBirth.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return false;
  }
  const eighteenthBirthday = new Date(Date.UTC(year + 18, month - 1, day));
  return eighteenthBirthday <= at;
}

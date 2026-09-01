import type {
  DiditDecisionSummary,
  DiditStatus,
} from "./kyc-policy.js";

export type ProofOfAddressStatus =
  | "not_started"
  | "creating"
  | "creation_failed"
  | "in_progress"
  | "pending_manual_review"
  | "current"
  | "insufficient"
  | "expired"
  | "restart_required"
  | "integration_anomaly";

export interface ProofOfAddressOutcome {
  status: ProofOfAddressStatus;
  reasonCode: string;
  currentUntil: Date | null;
}

const supportedCountryCodes = new Map([
  ["AT", "AT"], ["AUT", "AT"], ["BE", "BE"], ["BEL", "BE"],
  ["BG", "BG"], ["BGR", "BG"], ["HR", "HR"], ["HRV", "HR"],
  ["CY", "CY"], ["CYP", "CY"], ["CZ", "CZ"], ["CZE", "CZ"],
  ["DK", "DK"], ["DNK", "DK"], ["EE", "EE"], ["EST", "EE"],
  ["FI", "FI"], ["FIN", "FI"], ["FR", "FR"], ["FRA", "FR"],
  ["DE", "DE"], ["DEU", "DE"], ["GR", "GR"], ["GRC", "GR"],
  ["HU", "HU"], ["HUN", "HU"], ["IE", "IE"], ["IRL", "IE"],
  ["IT", "IT"], ["ITA", "IT"], ["LV", "LV"], ["LVA", "LV"],
  ["LT", "LT"], ["LTU", "LT"], ["LU", "LU"], ["LUX", "LU"],
  ["MT", "MT"], ["MLT", "MT"], ["NL", "NL"], ["NLD", "NL"],
  ["PL", "PL"], ["POL", "PL"], ["PT", "PT"], ["PRT", "PT"],
  ["RO", "RO"], ["ROU", "RO"], ["SK", "SK"], ["SVK", "SK"],
  ["SI", "SI"], ["SVN", "SI"], ["ES", "ES"], ["ESP", "ES"],
  ["SE", "SE"], ["SWE", "SE"], ["IS", "IS"], ["ISL", "IS"],
  ["LI", "LI"], ["LIE", "LI"], ["NO", "NO"], ["NOR", "NO"],
]);

export function evaluateProofOfAddressOutcome(input: {
  status: DiditStatus | null;
  decision: DiditDecisionSummary | null;
  residenceCountryCode: string | null;
  occurredAt: Date;
}): ProofOfAddressOutcome {
  switch (input.status) {
    case "Not Started":
    case "In Progress":
    case "Resubmitted":
      return outcome("in_progress", "OWNER_PROOF_OF_ADDRESS_PENDING");
    case "In Review":
      return outcome(
        "pending_manual_review",
        "OWNER_PROOF_OF_ADDRESS_INSUFFICIENT",
      );
    case "Declined":
      return outcome("insufficient", "OWNER_PROOF_OF_ADDRESS_INSUFFICIENT");
    case "Expired":
    case "Abandoned":
    case "Kyc Expired":
      return outcome("restart_required", "OWNER_PROOF_OF_ADDRESS_MISSING");
    case "Awaiting User":
    case null:
      return outcome("integration_anomaly", "PROVIDER_STATUS_ANOMALY");
    case "Approved":
      return evaluateApprovedProofOfAddress(input);
  }
}

function evaluateApprovedProofOfAddress(input: {
  decision: DiditDecisionSummary | null;
  residenceCountryCode: string | null;
  occurredAt: Date;
}): ProofOfAddressOutcome {
  const verifications = input.decision?.proofOfAddressVerifications ?? [];
  if (verifications.length === 0 || input.residenceCountryCode === null) {
    return outcome("integration_anomaly", "PROVIDER_STATUS_ANOMALY");
  }
  if (
    verifications.some(
      (verification) =>
        verification.status !== "Approved" || verification.warnings.length > 0,
    )
  ) {
    return outcome(
      "pending_manual_review",
      "OWNER_PROOF_OF_ADDRESS_INSUFFICIENT",
    );
  }

  const freshnessDates: Date[] = [];
  for (const verification of verifications) {
    const issueDate = parseIsoDate(verification.issueDate);
    const countryCode = normalizeCountryCode(verification.countryCode);
    if (
      issueDate === null ||
      issueDate > input.occurredAt ||
      countryCode === null ||
      countryCode !== input.residenceCountryCode
    ) {
      return outcome(
        "pending_manual_review",
        "OWNER_PROOF_OF_ADDRESS_INSUFFICIENT",
      );
    }
    freshnessDates.push(addUtcMonthsClamped(issueDate, 3));
  }

  const currentUntil = freshnessDates.reduce((earliest, date) =>
    date < earliest ? date : earliest,
  );
  if (currentUntil <= input.occurredAt) {
    return outcome("expired", "OWNER_PROOF_OF_ADDRESS_MISSING");
  }
  return {
    status: "current",
    reasonCode: "OWNER_PROOF_OF_ADDRESS_APPROVED",
    currentUntil,
  };
}

function outcome(
  status: ProofOfAddressStatus,
  reasonCode: string,
): ProofOfAddressOutcome {
  return { status, reasonCode, currentUntil: null };
}

function normalizeCountryCode(value: string | null): string | null {
  if (value === null) return null;
  return supportedCountryCodes.get(value.toUpperCase()) ?? null;
}

function parseIsoDate(value: string | null): Date | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? parsed
    : null;
}

function addUtcMonthsClamped(date: Date, months: number): Date {
  const targetMonth = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const finalDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(targetYear, normalizedMonth, Math.min(date.getUTCDate(), finalDay)),
  );
}

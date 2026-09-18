import { disclosureDocumentTypes } from "../../offering/domain/disclosure-pack.policy.js";
import { publicOfferingStatuses } from "../../offering/domain/public-offering.policy.js";

export const intakeStageLabels = {
  draft: "Draft",
  submitted: "Submitted",
  waiting_on_applicant: "Waiting on applicant",
  pre_offering_open: "Pre-offering open",
  post_ipo_structuring: "Post-IPO structuring",
  approved_for_final_offering: "Approved for final offering",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  expired: "Expired",
} as const;

export const intakeEvidenceStatusLabels = {
  pending: "Pending review",
  mandatory_missing: "Mandatory document missing",
  accepted: "Accepted",
  rejected: "Rejected",
} as const;

export const intakeInformationRequestStatusLabels = {
  proposed: "Proposed",
  published: "Published",
  answered: "Answered",
  withdrawn: "Withdrawn",
  expired: "Expired",
} as const;

export const intakeInformationRequestResolutionLabels = {
  resubmitted: "Resubmitted",
  withdrawn: "Withdrawn",
  expired: "Expired",
} as const;

export const intakeActionLabels = {
  review_evidence: "Review evidence",
  request_information: "Request information",
  record_founder_decision: "Record founder decision",
  assign_partner: "Assign partner",
  publish_disclosure_pack: "Publish disclosure pack",
  publish_final_offering_terms: "Publish final offering terms",
  retry_post_ipo_handoff: "Retry post-IPO handoff",
  close_case: "Close case",
} as const;

export const intakeBlockerLabels = {
  case_terminal: "Case is terminal",
  submission_missing: "Submission missing",
  evidence_missing: "Evidence missing",
  evidence_pending_review: "Evidence pending review",
  evidence_rejected: "Evidence rejected",
  evidence_mandatory_missing: "Mandatory evidence missing",
  founder_decision_missing: "Founder decision missing",
  partner_assignment_missing: "Partner assignment missing",
  legal_structuring_incomplete: "Legal structuring incomplete",
  appraisal_incomplete: "Appraisal incomplete",
  offering_missing: "Offering missing",
  disclosure_pack_missing: "Disclosure pack missing",
  disclosure_pack_incomplete: "Disclosure pack incomplete",
  funding_target_not_reached: "Funding target not reached",
  offering_final_terms_already_published: "Final offering terms already published",
  ipo_period_expired: "IPO period expired",
  post_ipo_handoff_pending: "Post-IPO handoff pending",
} as const;

export const intakeSeverityLabels = {
  blocking: "Blocking",
  warning: "Warning",
} as const;

export const intakeRoomTypeLabels = {
  bedroom: "Bedroom",
  bathroom: "Bathroom",
  kitchen: "Kitchen",
  living_room: "Living room",
  dining_room: "Dining room",
  office: "Office",
  storage: "Storage",
  other: "Other",
} as const;

export const intakeResidentialSubtypeLabels = {
  apartment: "Apartment",
  house: "House",
  townhouse: "Townhouse",
  multi_family: "Multi-family",
  studio: "Studio",
  other: "Other",
} as const;

export const intakePropertyConditionLabels = {
  new: "New",
  renovated: "Renovated",
  good: "Good",
  fair: "Fair",
  needs_renovation: "Needs renovation",
} as const;

export const intakeEnergyRatingLabels: Record<string, string> = {
  "A+": "A+",
  A: "A",
  B: "B",
  C: "C",
  D: "D",
  E: "E",
  F: "F",
  G: "G",
};

export const intakeDocumentTypeLabels: Record<string, string> = {
  ownership_declaration: "Ownership declaration",
  property_facts_sheet: "Property facts sheet",
  encumbrance_declaration: "Encumbrance declaration",
  photo_set: "Property photo set",
  room_photo: "Room photo",
};

export const disclosureDocumentTypeLabels: Record<string, string> = {
  ecsp_kiis: "ECSP KIIS",
  priips_kid: "PRIIPs KID",
  final_offer_summary: "Final offer summary",
  final_terms_sheet: "Final terms sheet",
  issuer_offeror_structure_sheet: "Issuer and offeror structure sheet",
  investor_rights_payout_waterfall_summary: "Investor rights and payout waterfall summary",
  risk_factors_summary: "Risk factors summary",
  property_appraisal_summary: "Property appraisal summary",
  fees_costs_tax_liquidity_summary: "Fees, costs, tax and liquidity summary",
  withdrawal_cancellation_supplement_rights_notice: "Withdrawal and cancellation rights notice",
  full_prospectus: "Full prospectus",
};

export const offeringStatusLabels: Record<string, string> = {
  pre_offering: "Pre-offering",
  final_offering: "Final offering",
  closed: "Closed",
};

export const reservationStageLabels: Record<string, string> = {
  initiated: "Initiated",
  awaiting_reconfirmation: "Awaiting reconfirmation",
  reconfirmed: "Reconfirmed",
  finalized: "Finalized",
  cancelled: "Cancelled",
  lapsed: "Lapsed",
};

export function displayLabel(
  value: string | null | undefined,
  labels: Record<string, string>,
): string | null {
  if (value === null || value === undefined) return null;
  return labels[value] ?? humanizeUnknownCode(value);
}

function humanizeUnknownCode(value: string): string {
  return value
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function labelsFor(values: readonly string[], labels: Record<string, string>): string[] {
  return values.map((value) => displayLabel(value, labels) ?? value);
}

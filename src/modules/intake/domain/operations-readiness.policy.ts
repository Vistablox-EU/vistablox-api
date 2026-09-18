export interface OperationsReadinessSnapshot {
  caseId: string;
  stage: string;
  submission: {
    revisionNumber: number;
    evidence: Array<{ documentType: string; status: string }>;
  } | null;
  legalPracticeId: string | null;
  legalStructuringCompletedAt: Date | null;
  appraisalFirmId: string | null;
  appraisalCompletedAt: Date | null;
  founder: {
    reviewedByAccountId: string | null;
    approvedAt: Date | null;
    rejectedAt: Date | null;
    ipoPeriodDays: number | null;
    ipoValueEur: string | null;
    ipoEndAt: Date | null;
  };
  offering: null | {
    offeringId: string;
    status: string;
    minimumRaiseEur: string;
    targetRaiseEur: string;
    finalOfferingPublishedAt: Date | null;
    platformRightsEndAt: Date | null;
    effectiveRightsEndAt: Date | null;
    disclosurePack: null | {
      id: string;
      version: number;
      publishedAt: Date;
      documentTypes: string[];
    };
    reservations: Array<{
      stage: string;
      amountEur: string;
      latestCapitalState: string | null;
      latestAmountEur: string | null;
    }>;
  };
}

export const readinessActions = [
  "review_evidence",
  "request_information",
  "record_founder_decision",
  "assign_partner",
  "publish_disclosure_pack",
  "publish_final_offering_terms",
  "retry_post_ipo_handoff",
  "close_case",
] as const;
export const readinessBlockerCodes = [
  "case_terminal",
  "submission_missing",
  "evidence_missing",
  "evidence_pending_review",
  "evidence_rejected",
  "evidence_mandatory_missing",
  "founder_decision_missing",
  "partner_assignment_missing",
  "legal_structuring_incomplete",
  "appraisal_incomplete",
  "offering_missing",
  "disclosure_pack_missing",
  "disclosure_pack_incomplete",
  "funding_target_not_reached",
  "offering_final_terms_already_published",
  "ipo_period_expired",
  "post_ipo_handoff_pending",
] as const;
const requiredEvidence = [
  "ownership_declaration",
  "property_facts_sheet",
  "encumbrance_declaration",
  "photo_set",
];
const requiredDisclosure = [
  "ecsp_kiis",
  "priips_kid",
  "final_offer_summary",
  "final_terms_sheet",
  "issuer_offeror_structure_sheet",
  "investor_rights_payout_waterfall_summary",
  "risk_factors_summary",
  "property_appraisal_summary",
  "fees_costs_tax_liquidity_summary",
  "withdrawal_cancellation_supplement_rights_notice",
  "full_prospectus",
];
type Action = (typeof readinessActions)[number];
type Code = (typeof readinessBlockerCodes)[number];
type Blocker = {
  code: Code;
  severity: "blocking" | "warning";
  blocks_actions: Action[];
  message: string;
  metadata?: Record<string, unknown>;
};

const money = (n: number) => n.toFixed(2);
const iso = (date: Date | null) => date?.toISOString() ?? null;

export function evaluateOperationsReadiness(
  snapshot: OperationsReadinessSnapshot,
  now: Date,
) {
  const evidence = snapshot.submission?.evidence ?? [];
  const presentEvidence = [
    ...new Set(evidence.map((item) => item.documentType)),
  ].sort();
  const missingEvidence = requiredEvidence.filter(
    (type) => !presentEvidence.includes(type),
  );
  const count = (status: string) =>
    evidence.filter((item) => item.status === status).length;
  const offering = snapshot.offering;
  const packTypes = offering?.disclosurePack?.documentTypes ?? [];
  const missingDisclosure = requiredDisclosure.filter(
    (type) => !packTypes.includes(type),
  );
  const reservations = offering?.reservations ?? [];
  const reserved = reservations
    .filter((r) => !["cancelled", "lapsed"].includes(r.stage))
    .reduce((n, r) => n + Number(r.amountEur), 0);
  const funded = reservations
    .filter((r) =>
      ["eurc_reserved", "reconfirmation_pending", "eurc_finalized"].includes(
        r.latestCapitalState ?? "",
      ),
    )
    .reduce((n, r) => n + Number(r.latestAmountEur ?? 0), 0);
  const target = Number(offering?.targetRaiseEur ?? 0);
  const blockers: Blocker[] = [];
  const add = (
    code: Code,
    severity: Blocker["severity"],
    blocks_actions: Action[],
    message: string,
    metadata?: Record<string, unknown>,
  ) =>
    blockers.push({
      code,
      severity,
      blocks_actions,
      message,
      ...(metadata === undefined ? {} : { metadata }),
    });
  const terminal = ["rejected", "withdrawn", "expired"].includes(
    snapshot.stage,
  );
  if (terminal)
    add(
      "case_terminal",
      "blocking",
      readinessActions.slice(),
      "This case has reached a terminal stage.",
    );
  if (!snapshot.submission)
    add(
      "submission_missing",
      "blocking",
      ["record_founder_decision", "request_information"],
      "The case has no current submission.",
    );
  if (missingEvidence.length)
    add(
      "evidence_missing",
      "warning",
      [],
      "Required evidence documents are missing.",
      { missing_document_types: missingEvidence },
    );
  if (count("pending"))
    add(
      "evidence_pending_review",
      "warning",
      [],
      "Some evidence documents are awaiting review.",
    );
  if (count("rejected"))
    add(
      "evidence_rejected",
      "warning",
      [],
      "Some evidence documents were rejected.",
    );
  if (count("mandatory_missing"))
    add(
      "evidence_mandatory_missing",
      "warning",
      [],
      "Some mandatory evidence was marked missing.",
    );
  if (!snapshot.founder.approvedAt && !snapshot.founder.rejectedAt)
    add(
      "founder_decision_missing",
      "blocking",
      ["publish_disclosure_pack", "publish_final_offering_terms"],
      "A founder decision has not been recorded.",
    );
  if (!offering)
    add(
      "offering_missing",
      "blocking",
      ["publish_disclosure_pack", "publish_final_offering_terms"],
      "No offering is linked to this case.",
    );
  if (offering && !offering.disclosurePack)
    add(
      "disclosure_pack_missing",
      "blocking",
      ["publish_final_offering_terms"],
      "No current disclosure pack exists.",
    );
  if (offering?.disclosurePack && missingDisclosure.length)
    add(
      "disclosure_pack_incomplete",
      "blocking",
      ["publish_final_offering_terms"],
      "The current disclosure pack is incomplete.",
      { missing_document_types: missingDisclosure },
    );
  if (offering && funded < target)
    add(
      "funding_target_not_reached",
      "blocking",
      ["publish_final_offering_terms"],
      "The offering has not reached its full funded target.",
      { shortfall_eur: money(target - funded) },
    );
  if (offering?.finalOfferingPublishedAt)
    add(
      "offering_final_terms_already_published",
      "blocking",
      ["publish_final_offering_terms", "publish_disclosure_pack"],
      "Final offering terms have already been published.",
    );
  if (
    snapshot.founder.ipoEndAt &&
    snapshot.founder.ipoEndAt < now &&
    funded < target
  )
    add(
      "ipo_period_expired",
      "blocking",
      ["publish_final_offering_terms"],
      "The IPO period has expired.",
    );
  const handoffPending =
    snapshot.stage === "pre_offering_open" &&
    offering?.finalOfferingPublishedAt !== null &&
    offering?.finalOfferingPublishedAt !== undefined;
  if (handoffPending)
    add(
      "post_ipo_handoff_pending",
      "blocking",
      ["assign_partner"],
      "The post-IPO structuring handoff is pending.",
    );
  if (
    ["post_ipo_structuring", "approved_for_final_offering"].includes(
      snapshot.stage,
    )
  ) {
    if (!snapshot.legalPracticeId || !snapshot.appraisalFirmId)
      add(
        "partner_assignment_missing",
        "blocking",
        [],
        "Legal and appraisal partners must both be assigned.",
      );
    if (!snapshot.legalStructuringCompletedAt)
      add(
        "legal_structuring_incomplete",
        "blocking",
        [],
        "Legal structuring is incomplete.",
      );
    if (!snapshot.appraisalCompletedAt)
      add("appraisal_incomplete", "blocking", [], "Appraisal is incomplete.");
  }
  const blocked = new Set(
    blockers
      .filter((b) => b.severity === "blocking")
      .flatMap((b) => b.blocks_actions),
  );
  const actions: Action[] = [];
  if (!terminal) {
    actions.push("review_evidence");
    if (snapshot.stage === "submitted" && snapshot.submission)
      actions.push("request_information", "record_founder_decision");
    if (
      ["post_ipo_structuring", "approved_for_final_offering"].includes(
        snapshot.stage,
      )
    )
      actions.push("assign_partner");
    if (offering && offering.status === "pre_offering")
      actions.push("publish_disclosure_pack");
    if (offering?.status === "pre_offering")
      actions.push("publish_final_offering_terms");
    if (handoffPending) actions.push("retry_post_ipo_handoff");
    if (
      [
        "draft",
        "submitted",
        "waiting_on_applicant",
        "pre_offering_open",
      ].includes(snapshot.stage)
    )
      actions.push("close_case");
  }
  const allowed = actions.filter((action) => !blocked.has(action));
  return {
    data: {
      case_id: snapshot.caseId,
      stage: snapshot.stage,
      stage_label: displayLabel(snapshot.stage, intakeStageLabels)!,
      linked_offering:
        offering === null
          ? null
          : {
              offering_id: offering.offeringId,
              status: offering.status,
              status_label: displayLabel(offering.status, offeringStatusLabels)!,
              minimum_raise_eur: offering.minimumRaiseEur,
              target_raise_eur: offering.targetRaiseEur,
              final_offering_published_at: iso(
                offering.finalOfferingPublishedAt,
              ),
              platform_rights_end_at: iso(offering.platformRightsEndAt),
              effective_rights_end_at: iso(offering.effectiveRightsEndAt),
              ipo_end_at: iso(snapshot.founder.ipoEndAt),
            },
      evidence: {
        submission_present: snapshot.submission !== null,
        revision_number: snapshot.submission?.revisionNumber ?? null,
        required_document_types: requiredEvidence,
        required_document_type_labels: labelsFor(requiredEvidence, intakeDocumentTypeLabels),
        present_document_types: presentEvidence,
        present_document_type_labels: labelsFor(presentEvidence, intakeDocumentTypeLabels),
        missing_document_types: missingEvidence,
        missing_document_type_labels: labelsFor(missingEvidence, intakeDocumentTypeLabels),
        accepted_count: count("accepted"),
        pending_count: count("pending"),
        rejected_count: count("rejected"),
        mandatory_missing_count: count("mandatory_missing"),
        complete: missingEvidence.length === 0,
        rejected_documents: evidence
          .filter((e) => e.status === "rejected")
          .map((e) => e.documentType),
        rejected_document_labels: evidence
          .filter((e) => e.status === "rejected")
          .map((e) => displayLabel(e.documentType, intakeDocumentTypeLabels) ?? e.documentType),
      },
      partner_assignments: {
        legal_practice_id: snapshot.legalPracticeId,
        legal_structuring_completed_at: iso(
          snapshot.legalStructuringCompletedAt,
        ),
        appraisal_firm_id: snapshot.appraisalFirmId,
        appraisal_completed_at: iso(snapshot.appraisalCompletedAt),
        assignment_complete:
          snapshot.legalPracticeId !== null &&
          snapshot.appraisalFirmId !== null,
        structuring_complete:
          snapshot.legalStructuringCompletedAt !== null &&
          snapshot.appraisalCompletedAt !== null,
      },
      founder_decision: {
        status: snapshot.founder.approvedAt
          ? "approved"
          : snapshot.founder.rejectedAt
            ? "rejected"
            : "pending",
        status_label: displayLabel(
          snapshot.founder.approvedAt ? "approved" : snapshot.founder.rejectedAt ? "rejected" : "pending",
          { pending: "Pending", approved: "Approved", rejected: "Rejected" },
        )!,
        reviewed_by_account_id: snapshot.founder.reviewedByAccountId,
        approved_at: iso(snapshot.founder.approvedAt),
        rejected_at: iso(snapshot.founder.rejectedAt),
        ipo_period_days: snapshot.founder.ipoPeriodDays,
        ipo_value_eur: snapshot.founder.ipoValueEur,
        ipo_end_at: iso(snapshot.founder.ipoEndAt),
      },
      disclosure_pack:
        offering?.disclosurePack === null || offering === null
          ? null
          : {
              current_pack_id: offering.disclosurePack.id,
              version: offering.disclosurePack.version,
              published_at: iso(offering.disclosurePack.publishedAt),
              present_document_types: packTypes.sort(),
              present_document_type_labels: labelsFor(packTypes, disclosureDocumentTypeLabels),
              missing_document_types: missingDisclosure,
              missing_document_type_labels: labelsFor(missingDisclosure, disclosureDocumentTypeLabels),
              complete: missingDisclosure.length === 0,
            },
      funding:
        offering === null
          ? null
          : {
              target_raise_eur: offering.targetRaiseEur,
              reserved_eur: money(reserved),
              funded_eur: money(funded),
              remaining_eur: money(Math.max(0, target - funded)),
              funded_percent:
                target === 0
                  ? 0
                  : Number(Math.min(100, (funded / target) * 100).toFixed(2)),
              reservation_counts: Object.fromEntries(
                [
                  "initiated",
                  "awaiting_reconfirmation",
                  "reconfirmed",
                  "finalized",
                  "cancelled",
                  "lapsed",
                ].map((stage) => [
                  stage,
                  reservations.filter((r) => r.stage === stage).length,
                ]),
              ),
              reservation_stage_labels: Object.fromEntries(
                [
                  "initiated",
                  "awaiting_reconfirmation",
                  "reconfirmed",
                  "finalized",
                  "cancelled",
                  "lapsed",
                ].map((stage) => [stage, displayLabel(stage, reservationStageLabels)]),
              ),
              funded_reservation_count: reservations.filter((r) =>
                [
                  "eurc_reserved",
                  "reconfirmation_pending",
                  "eurc_finalized",
                ].includes(r.latestCapitalState ?? ""),
              ).length,
            },
      allowed_next_actions: allowed,
      allowed_next_action_labels: labelsFor(allowed, intakeActionLabels),
      blockers: blockers.map((blocker) => ({
        ...blocker,
        code_label: displayLabel(blocker.code, intakeBlockerLabels)!,
        severity_label: displayLabel(blocker.severity, intakeSeverityLabels)!,
        blocks_action_labels: labelsFor(blocker.blocks_actions, intakeActionLabels),
      })),
    },
  };
}
import {
  displayLabel,
  intakeActionLabels,
  intakeBlockerLabels,
  intakeDocumentTypeLabels,
  intakeSeverityLabels,
  intakeStageLabels,
  labelsFor,
  offeringStatusLabels,
  reservationStageLabels,
  disclosureDocumentTypeLabels,
} from "../presentation/intake-labels.js";

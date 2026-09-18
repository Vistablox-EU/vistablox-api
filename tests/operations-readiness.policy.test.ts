import { describe, expect, it } from "vitest";

import {
  evaluateOperationsReadiness,
  type OperationsReadinessSnapshot,
} from "../src/modules/intake/domain/operations-readiness.policy.js";

const now = new Date("2026-09-16T12:00:00.000Z");
const evidence = [
  "ownership_declaration",
  "property_facts_sheet",
  "encumbrance_declaration",
  "photo_set",
];
const disclosure = [
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

function snapshot(
  overrides: Partial<OperationsReadinessSnapshot> = {},
): OperationsReadinessSnapshot {
  return {
    caseId: "case_01",
    stage: "submitted",
    submission: {
      revisionNumber: 1,
      evidence: evidence.map((documentType) => ({
        documentType,
        status: "accepted",
      })),
    },
    legalPracticeId: null,
    legalStructuringCompletedAt: null,
    appraisalFirmId: null,
    appraisalCompletedAt: null,
    founder: {
      reviewedByAccountId: "acct_staff",
      approvedAt: new Date("2026-09-10T12:00:00.000Z"),
      rejectedAt: null,
      ipoPeriodDays: 30,
      ipoValueEur: "100.00",
      ipoEndAt: new Date("2026-10-01T00:00:00.000Z"),
    },
    offering: {
      offeringId: "offering_01",
      status: "pre_offering",
      minimumRaiseEur: "50.00",
      targetRaiseEur: "100.00",
      finalOfferingPublishedAt: null,
      platformRightsEndAt: null,
      effectiveRightsEndAt: null,
      disclosurePack: {
        id: "pack_01",
        version: 1,
        publishedAt: now,
        documentTypes: disclosure,
      },
      reservations: [
        {
          stage: "initiated",
          amountEur: "100.00",
          latestCapitalState: "eurc_reserved",
          latestAmountEur: "100.00",
        },
      ],
    },
    ...overrides,
  };
}

const readiness = (input?: Partial<OperationsReadinessSnapshot>) =>
  evaluateOperationsReadiness(snapshot(input), now).data;
const codes = (input?: Partial<OperationsReadinessSnapshot>) =>
  readiness(input).blockers.map((blocker) => blocker.code);

describe("operations readiness policy", () => {
  it("does not turn advisory evidence review into a founder-decision gate", () => {
    const data = readiness({
      submission: {
        revisionNumber: 1,
        evidence: [
          { documentType: "ownership_declaration", status: "rejected" },
        ],
      },
    });
    expect(data.allowed_next_actions).toContain("record_founder_decision");
    expect(
      data.blockers.find((blocker) => blocker.code === "evidence_rejected")
        ?.severity,
    ).toBe("warning");
  });

  it("reports missing submission and suppresses submission-dependent actions", () => {
    const data = readiness({
      submission: null,
      founder: { ...snapshot().founder, approvedAt: null },
    });
    expect(
      codes({
        submission: null,
        founder: { ...snapshot().founder, approvedAt: null },
      }),
    ).toContain("submission_missing");
    expect(data.allowed_next_actions).not.toContain("record_founder_decision");
  });

  it("reports exact missing disclosure documents and blocks final terms", () => {
    const data = readiness({
      offering: {
        ...snapshot().offering!,
        disclosurePack: {
          ...snapshot().offering!.disclosurePack!,
          documentTypes: ["ecsp_kiis"],
        },
      },
    });
    expect(data.disclosure_pack?.missing_document_types).toContain(
      "priips_kid",
    );
    expect(data.allowed_next_actions).not.toContain(
      "publish_final_offering_terms",
    );
  });

  it("uses only current latest money-event states and excludes cancelled capacity", () => {
    const data = readiness({
      offering: {
        ...snapshot().offering!,
        reservations: [
          {
            stage: "initiated",
            amountEur: "80.00",
            latestCapitalState: "eurc_reserved",
            latestAmountEur: "80.00",
          },
          {
            stage: "cancelled",
            amountEur: "30.00",
            latestCapitalState: "eurc_finalized",
            latestAmountEur: "30.00",
          },
          {
            stage: "lapsed",
            amountEur: "10.00",
            latestCapitalState: null,
            latestAmountEur: null,
          },
        ],
      },
    });
    expect(data.funding).toMatchObject({
      reserved_eur: "80.00",
      funded_eur: "110.00",
      funded_percent: 100,
    });
    expect(
      codes({
        offering: {
          ...snapshot().offering!,
          reservations: [
            {
              stage: "initiated",
              amountEur: "80.00",
              latestCapitalState: "eurc_reserved",
              latestAmountEur: "80.00",
            },
          ],
        },
      }),
    ).toContain("funding_target_not_reached");
  });

  it("exposes assignment only during post-IPO structuring and hides all mutations once terminal", () => {
    expect(
      readiness({ stage: "post_ipo_structuring" }).allowed_next_actions,
    ).toContain("assign_partner");
    expect(readiness({ stage: "withdrawn" }).allowed_next_actions).toEqual([]);
  });

  it("detects expired IPOs and stuck post-IPO handoffs", () => {
    expect(
      codes({
        founder: {
          ...snapshot().founder,
          ipoEndAt: new Date("2026-09-01T00:00:00.000Z"),
        },
        offering: { ...snapshot().offering!, reservations: [] },
      }),
    ).toContain("ipo_period_expired");
    expect(
      codes({
        stage: "pre_offering_open",
        offering: { ...snapshot().offering!, finalOfferingPublishedAt: now },
      }),
    ).toContain("post_ipo_handoff_pending");
  });
});

import { describe, expect, it } from "vitest";

import {
  evaluateDiditOutcome,
  isRenewalOverdue,
  isRenewalReminderDue,
  type DiditDecisionSummary,
} from "../src/modules/identity/domain/kyc-policy.js";

const occurredAt = new Date("2026-09-01T12:00:00.000Z");

function approvedDecision(overrides: Partial<DiditDecisionSummary> = {}): DiditDecisionSummary {
  return {
    sessionId: "c2237bc6-a76c-4933-b329-6c81843b45c7",
    sessionKind: "user",
    workflowId: "269214fe-77f7-4b1a-a028-b70e861d73c1",
    vendorData: "acct_01",
    status: "Approved",
    idVerifications: [
      { status: "Approved", dateOfBirth: "1990-04-15", warnings: [] },
    ],
    livenessChecks: [{ status: "Approved", warnings: [] }],
    faceMatches: [{ status: "Approved", warnings: [] }],
    amlScreenings: [{ status: "Approved", totalHits: 0, warnings: [] }],
    proofOfAddressVerifications: [],
    verifiedDisplayProfile: null,
    ...overrides,
  };
}

describe("Didit KYC policy", () => {
  it("grants baseline eligibility only when all required evidence passes", () => {
    const result = evaluateDiditOutcome({
      status: "Approved",
      decision: approvedDecision(),
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "HR",
      everRequiredManualReview: false,
      occurredAt,
    });

    expect(result).toEqual({
      eligibilityState: "eligible",
      operationalSubstatus: "kyc_verified_owner_poa_missing",
      reasonCode: "KYC_BASELINE_APPROVED",
      lastVerifiedAt: occurredAt,
      everRequiredManualReview: false,
      renewalDueAt: new Date("2028-09-01T12:00:00.000Z"),
    });
  });

  it("sets a 12-month renewal instead of 24 for an account with any manual-review history", () => {
    const result = evaluateDiditOutcome({
      status: "Approved",
      decision: approvedDecision(),
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "HR",
      everRequiredManualReview: true,
      occurredAt,
    });

    expect(result).toMatchObject({
      eligibilityState: "eligible",
      everRequiredManualReview: true,
      renewalDueAt: new Date("2027-09-01T12:00:00.000Z"),
    });
  });

  it("latches everRequiredManualReview once a decision resolves to manual review, even on a later clean approval", () => {
    const flaggedByThisDecision = evaluateDiditOutcome({
      status: "Approved",
      decision: approvedDecision({
        amlScreenings: [{ status: "Approved", totalHits: 1, warnings: [{ risk: "pep match" }] }],
      }),
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "HR",
      everRequiredManualReview: false,
      occurredAt,
    });
    expect(flaggedByThisDecision).toMatchObject({
      eligibilityState: "pending_manual_review",
      everRequiredManualReview: true,
    });

    const laterCleanApproval = evaluateDiditOutcome({
      status: "Approved",
      decision: approvedDecision(),
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "HR",
      everRequiredManualReview: true,
      occurredAt,
    });
    expect(laterCleanApproval).toMatchObject({
      eligibilityState: "eligible",
      everRequiredManualReview: true,
      renewalDueAt: new Date("2027-09-01T12:00:00.000Z"),
    });
  });

  it("blocks unsupported residence or tax jurisdictions", () => {
    expect(
      evaluateDiditOutcome({
        status: "Approved",
        decision: approvedDecision(),
        residenceCountryCode: "US",
        taxResidenceCountryCode: "DE",
        everRequiredManualReview: false,
        occurredAt,
      }),
    ).toMatchObject({
      eligibilityState: "unsupported_jurisdiction",
      reasonCode: "JURISDICTION_UNSUPPORTED",
    });
  });

  it("rejects underage and invalid calendar dates", () => {
    for (const dateOfBirth of ["2010-01-01", "2000-02-31"]) {
      expect(
        evaluateDiditOutcome({
          status: "Approved",
          decision: approvedDecision({
            idVerifications: [{ status: "Approved", dateOfBirth, warnings: [] }],
          }),
          residenceCountryCode: "DE",
          taxResidenceCountryCode: "DE",
          everRequiredManualReview: false,
          occurredAt,
        }),
      ).toMatchObject({ eligibilityState: "not_eligible", reasonCode: "AGE_UNDER_18" });
    }
  });

  it("sends AML hits and incomplete provider evidence to manual review", () => {
    const amlHit = evaluateDiditOutcome({
      status: "Approved",
      decision: approvedDecision({
        amlScreenings: [
          {
            status: "Approved",
            totalHits: 1,
            warnings: [{ risk: "pep match" }],
          },
        ],
      }),
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "DE",
      everRequiredManualReview: false,
      occurredAt,
    });
    const incomplete = evaluateDiditOutcome({
      status: "Approved",
      decision: approvedDecision({ faceMatches: [] }),
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "DE",
      everRequiredManualReview: false,
      occurredAt,
    });

    expect(amlHit).toMatchObject({
      eligibilityState: "pending_manual_review",
      reasonCode: "AML_PEP_REVIEW",
    });
    expect(incomplete).toMatchObject({
      eligibilityState: "pending_manual_review",
      operationalSubstatus: "kyc_integration_anomaly",
    });
  });

  it("maps expiry and unknown statuses without granting eligibility", () => {
    expect(
      evaluateDiditOutcome({
        status: "Kyc Expired",
        decision: null,
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "DE",
        everRequiredManualReview: false,
        occurredAt,
      }),
    ).toMatchObject({ eligibilityState: "requires_renewal" });
    expect(
      evaluateDiditOutcome({
        status: null,
        decision: null,
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "DE",
        everRequiredManualReview: false,
        occurredAt,
      }),
    ).toMatchObject({ operationalSubstatus: "kyc_integration_anomaly" });
  });
});

describe("KYC renewal timer policy", () => {
  it("treats renewal as overdue only once renewal_due_at has passed", () => {
    const renewalDueAt = new Date("2028-09-01T00:00:00.000Z");
    expect(
      isRenewalOverdue({ renewalDueAt, now: new Date("2028-08-31T23:59:59.999Z") }),
    ).toBe(false);
    expect(isRenewalOverdue({ renewalDueAt, now: new Date("2028-09-01T00:00:00.001Z") })).toBe(
      true,
    );
  });

  it("matches the reminder date only on the exact lead-time day before renewal_due_at", () => {
    const renewalDueAt = new Date("2028-09-01T00:00:00.000Z");
    expect(
      isRenewalReminderDue({
        renewalDueAt,
        today: new Date("2028-08-02T09:00:00.000Z"),
        leadDays: 30,
      }),
    ).toBe(true);
    expect(
      isRenewalReminderDue({
        renewalDueAt,
        today: new Date("2028-08-01T09:00:00.000Z"),
        leadDays: 30,
      }),
    ).toBe(false);
  });
});

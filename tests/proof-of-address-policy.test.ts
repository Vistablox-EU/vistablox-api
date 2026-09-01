import { describe, expect, it } from "vitest";

import type { DiditDecisionSummary } from "../src/modules/identity/domain/kyc-policy.js";
import { evaluateProofOfAddressOutcome } from "../src/modules/identity/domain/proof-of-address-policy.js";

const occurredAt = new Date("2026-09-01T12:00:00.000Z");

function decision(
  overrides: Partial<DiditDecisionSummary> = {},
): DiditDecisionSummary {
  return {
    sessionId: "2ecf635b-b3df-43ed-9148-d64e8d6f5bd2",
    sessionKind: "user",
    workflowId: "bb17fe44-5b38-48f3-acb7-39dbc38c9317",
    vendorData: "acct_01",
    status: "Approved",
    idVerifications: [],
    livenessChecks: [],
    faceMatches: [],
    amlScreenings: [],
    proofOfAddressVerifications: [
      {
        status: "Approved",
        issueDate: "2026-06-15",
        countryCode: "DEU",
        warnings: [],
      },
    ],
    ...overrides,
  };
}

describe("Didit proof-of-address policy", () => {
  it("accepts a recent approved document from the declared residence", () => {
    expect(
      evaluateProofOfAddressOutcome({
        status: "Approved",
        decision: decision(),
        residenceCountryCode: "DE",
        occurredAt,
      }),
    ).toEqual({
      status: "current",
      reasonCode: "OWNER_PROOF_OF_ADDRESS_APPROVED",
      currentUntil: new Date("2026-09-15T00:00:00.000Z"),
    });
  });

  it("rejects stale documents instead of extending freshness from approval time", () => {
    expect(
      evaluateProofOfAddressOutcome({
        status: "Approved",
        decision: decision({
          proofOfAddressVerifications: [
            {
              status: "Approved",
              issueDate: "2026-05-31",
              countryCode: "DE",
              warnings: [],
            },
          ],
        }),
        residenceCountryCode: "DE",
        occurredAt,
      }),
    ).toMatchObject({
      status: "expired",
      reasonCode: "OWNER_PROOF_OF_ADDRESS_MISSING",
      currentUntil: null,
    });
  });

  it.each([
    {
      label: "country mismatch",
      verification: {
        status: "Approved",
        issueDate: "2026-06-15",
        countryCode: "FRA",
        warnings: [],
      },
    },
    {
      label: "provider warning",
      verification: {
        status: "Approved",
        issueDate: "2026-06-15",
        countryCode: "DE",
        warnings: [{ risk: "POA_NAME_MISMATCH" }],
      },
    },
    {
      label: "invalid issue date",
      verification: {
        status: "Approved",
        issueDate: "2026-02-31",
        countryCode: "DE",
        warnings: [],
      },
    },
  ])("sends $label to manual review", ({ verification }) => {
    expect(
      evaluateProofOfAddressOutcome({
        status: "Approved",
        decision: decision({ proofOfAddressVerifications: [verification] }),
        residenceCountryCode: "DE",
        occurredAt,
      }),
    ).toMatchObject({
      status: "pending_manual_review",
      reasonCode: "OWNER_PROOF_OF_ADDRESS_INSUFFICIENT",
    });
  });

  it("maps incomplete and anomalous provider outcomes without opening owner intake", () => {
    expect(
      evaluateProofOfAddressOutcome({
        status: "Declined",
        decision: null,
        residenceCountryCode: "DE",
        occurredAt,
      }),
    ).toMatchObject({ status: "insufficient" });
    expect(
      evaluateProofOfAddressOutcome({
        status: "Approved",
        decision: decision({ proofOfAddressVerifications: [] }),
        residenceCountryCode: "DE",
        occurredAt,
      }),
    ).toMatchObject({ status: "integration_anomaly" });
  });
});

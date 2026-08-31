import { describe, expect, it } from "vitest";

import {
  evaluateIntakeEntry,
  type IntakeEntryPolicyInput,
} from "../src/modules/origination/domain/intake-entry.policy.js";

const validInput: IntakeEntryPolicyInput = {
  eligibilityState: "eligible",
  proofOfAddressCurrentUntil: new Date("2027-01-01T00:00:00.000Z"),
  now: new Date("2026-08-31T00:00:00.000Z"),
  declaredValueCents: 15_000_000n,
  minimumValueCents: 15_000_000n,
  intakeTermsAccepted: true,
  oneTitleConfirmed: true,
  propertyType: "residential",
};

describe("owner intake entry policy", () => {
  it("allows an eligible owner at the configured property-value floor", () => {
    expect(evaluateIntakeEntry(validInput)).toEqual({ allowed: true });
  });

  it.each([
    [{ eligibilityState: "in_progress" }, "kyc_not_eligible"],
    [{ proofOfAddressCurrentUntil: null }, "proof_of_address_required"],
    [
      { proofOfAddressCurrentUntil: new Date("2026-08-31T00:00:00.000Z") },
      "proof_of_address_required",
    ],
    [{ intakeTermsAccepted: false }, "terms_not_accepted"],
    [{ oneTitleConfirmed: false }, "one_title_required"],
    [{ propertyType: "commercial" }, "residential_only"],
    [{ declaredValueCents: 14_999_999n }, "property_value_below_minimum"],
  ] as const)("rejects a failed prerequisite", (override, reason) => {
    expect(evaluateIntakeEntry({ ...validInput, ...override })).toEqual({
      allowed: false,
      reason,
    });
  });
});

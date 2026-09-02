import { describe, expect, it } from "vitest";

import { costBasisToUnitCount, isOfferingFinalizable } from "../src/modules/offering/domain/finalization.policy.js";

describe("isOfferingFinalizable", () => {
  it("is finalizable once funded_eur meets the full target with the offering still pre_offering", () => {
    expect(
      isOfferingFinalizable({ status: "pre_offering", targetRaiseEur: "500000.00", fundedEur: "500000.00" }),
    ).toBe(true);
  });

  it("is finalizable when funded_eur exceeds the target (should not happen given the capacity check, but is not itself disqualifying)", () => {
    expect(
      isOfferingFinalizable({ status: "pre_offering", targetRaiseEur: "500000.00", fundedEur: "500000.01" }),
    ).toBe(true);
  });

  it("is not finalizable with any shortfall, however small (AD-245: no partial-funding path)", () => {
    expect(
      isOfferingFinalizable({ status: "pre_offering", targetRaiseEur: "500000.00", fundedEur: "499999.99" }),
    ).toBe(false);
  });

  it("is not finalizable once the offering has left pre_offering, even if fully funded", () => {
    expect(
      isOfferingFinalizable({ status: "final_offering", targetRaiseEur: "500000.00", fundedEur: "500000.00" }),
    ).toBe(false);
  });
});

describe("costBasisToUnitCount", () => {
  it("is a 1-unit-per-EUR identity mapping", () => {
    expect(costBasisToUnitCount("1000.00")).toBe("1000.00");
  });
});

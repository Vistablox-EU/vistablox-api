import { describe, expect, it } from "vitest";

import {
  canPublishFinalOfferingTerms,
  computeEffectiveRightsEndAt,
  costBasisToUnitCount,
  isReconfirmationWindowOpen,
  PLATFORM_RIGHTS_WINDOW_HOURS,
} from "../src/modules/offering/domain/finalization.policy.js";

describe("canPublishFinalOfferingTerms", () => {
  it("is publishable once funded_eur meets the full target, still pre_offering and not yet published", () => {
    expect(
      canPublishFinalOfferingTerms({
        status: "pre_offering",
        finalOfferingPublishedAt: null,
        targetRaiseEur: "500000.00",
        fundedEur: "500000.00",
      }),
    ).toBe(true);
  });

  it("is publishable when funded_eur exceeds the target (should not happen given the capacity check, but is not itself disqualifying)", () => {
    expect(
      canPublishFinalOfferingTerms({
        status: "pre_offering",
        finalOfferingPublishedAt: null,
        targetRaiseEur: "500000.00",
        fundedEur: "500000.01",
      }),
    ).toBe(true);
  });

  it("is not publishable with any shortfall, however small (AD-245: no partial-funding path)", () => {
    expect(
      canPublishFinalOfferingTerms({
        status: "pre_offering",
        finalOfferingPublishedAt: null,
        targetRaiseEur: "500000.00",
        fundedEur: "499999.99",
      }),
    ).toBe(false);
  });

  it("is not publishable once the offering has left pre_offering, even if fully funded", () => {
    expect(
      canPublishFinalOfferingTerms({
        status: "final_offering",
        finalOfferingPublishedAt: null,
        targetRaiseEur: "500000.00",
        fundedEur: "500000.00",
      }),
    ).toBe(false);
  });

  it("is not publishable a second time once final terms are already published", () => {
    expect(
      canPublishFinalOfferingTerms({
        status: "pre_offering",
        finalOfferingPublishedAt: new Date("2026-09-01T00:00:00.000Z"),
        targetRaiseEur: "500000.00",
        fundedEur: "500000.00",
      }),
    ).toBe(false);
  });
});

describe("computeEffectiveRightsEndAt", () => {
  it("is exactly 168 hours after publication", () => {
    expect(PLATFORM_RIGHTS_WINDOW_HOURS).toBe(168);
    expect(computeEffectiveRightsEndAt(new Date("2026-09-02T10:00:00.000Z"))).toEqual(
      new Date("2026-09-09T10:00:00.000Z"),
    );
  });
});

describe("isReconfirmationWindowOpen", () => {
  it("is open strictly before the window's end", () => {
    expect(
      isReconfirmationWindowOpen({
        effectiveRightsEndAt: new Date("2026-09-09T10:00:00.000Z"),
        now: new Date("2026-09-09T09:59:59.999Z"),
      }),
    ).toBe(true);
  });

  it("is closed exactly at, and after, the window's end", () => {
    expect(
      isReconfirmationWindowOpen({
        effectiveRightsEndAt: new Date("2026-09-09T10:00:00.000Z"),
        now: new Date("2026-09-09T10:00:00.000Z"),
      }),
    ).toBe(false);
    expect(
      isReconfirmationWindowOpen({
        effectiveRightsEndAt: new Date("2026-09-09T10:00:00.000Z"),
        now: new Date("2026-09-09T10:00:01.000Z"),
      }),
    ).toBe(false);
  });
});

describe("costBasisToUnitCount", () => {
  it("is a 1-unit-per-EUR identity mapping", () => {
    expect(costBasisToUnitCount("1000.00")).toBe("1000.00");
  });
});

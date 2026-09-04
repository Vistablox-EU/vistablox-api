import { describe, expect, it } from "vitest";

import {
  computeAmountPerUnit,
  computeDistributableNet,
  computeEntryAmount,
} from "../src/modules/rental/domain/operating-distribution.policy.js";

describe("computeDistributableNet", () => {
  it("subtracts fee, expenses, and reserve from gross rent", () => {
    expect(
      computeDistributableNet({
        grossRentEur: "1000.00",
        managementFeeEur: "100.00",
        otherExpensesEur: "50.00",
        reserveHoldbackEur: "25.00",
      }),
    ).toBe("825.00");
  });

  it("floors at zero rather than going negative", () => {
    expect(
      computeDistributableNet({
        grossRentEur: "100.00",
        managementFeeEur: "50.00",
        otherExpensesEur: "60.00",
        reserveHoldbackEur: "0.00",
      }),
    ).toBe("0.00");
  });

  it("returns the full gross amount when there are no deductions", () => {
    expect(
      computeDistributableNet({
        grossRentEur: "500.00",
        managementFeeEur: "0.00",
        otherExpensesEur: "0.00",
        reserveHoldbackEur: "0.00",
      }),
    ).toBe("500.00");
  });
});

describe("computeAmountPerUnit", () => {
  it("divides evenly for a round number of units", () => {
    expect(computeAmountPerUnit({ distributableNetEur: "1000.00", totalUnits: "1000" })).toBe(
      "1.000000",
    );
  });

  it("preserves sub-cent precision for a small distribution over many units", () => {
    // The exact scenario this module exists for: €500 over 100,000 units is
    // €0.005/unit, which rounds to €0.00 at 2-decimal precision -- silently
    // paying every small holder nothing. Six-decimal precision keeps it real.
    expect(computeAmountPerUnit({ distributableNetEur: "500.00", totalUnits: "100000" })).toBe(
      "0.005000",
    );
  });

  it("throws when totalUnits is zero or negative", () => {
    expect(() => computeAmountPerUnit({ distributableNetEur: "10.00", totalUnits: "0" })).toThrow();
    expect(() => computeAmountPerUnit({ distributableNetEur: "10.00", totalUnits: "-5" })).toThrow();
  });
});

describe("computeEntryAmount", () => {
  it("multiplies unit count by the per-unit amount", () => {
    expect(computeEntryAmount({ unitCount: "1000", amountPerUnitEur: "0.005000" })).toBe(
      "5.000000",
    );
  });

  it("pays a holder of the sub-cent-precision units their fair fractional share", () => {
    // Same €500/100,000-unit property as above: a holder of 1,000 units
    // (1% of the property) should get exactly 1% of the distribution.
    const amountPerUnit = computeAmountPerUnit({
      distributableNetEur: "500.00",
      totalUnits: "100000",
    });
    expect(computeEntryAmount({ unitCount: "1000", amountPerUnitEur: amountPerUnit })).toBe(
      "5.000000",
    );
  });
});

describe("pro-rata fairness invariant", () => {
  it("never distributes more than the distributable net across all holders", () => {
    // 10.00 / 3 doesn't divide evenly -- exactly the case that proves the
    // "truncate down, never round up" rule actually holds under real math,
    // not just in a contrived clean-division example.
    const distributableNetEur = "10.00";
    const holders = [{ units: "1" }, { units: "1" }, { units: "1" }];
    const totalUnits = "3";

    const amountPerUnit = computeAmountPerUnit({ distributableNetEur, totalUnits });
    const entries = holders.map((holder) =>
      computeEntryAmount({ unitCount: holder.units, amountPerUnitEur: amountPerUnit }),
    );

    const sum = entries.reduce((total, entry) => total + Number(entry), 0);
    expect(sum).toBeLessThanOrEqual(Number(distributableNetEur));
    // The only acceptable "loss" is sub-micro-EUR truncation dust, not a
    // meaningful fraction of the distribution left unpaid.
    expect(Number(distributableNetEur) - sum).toBeLessThan(0.00001);
  });

  it("distributes the exact total when units divide evenly", () => {
    const distributableNetEur = "10.00";
    const holders = [{ units: "300" }, { units: "300" }, { units: "400" }];
    const totalUnits = "1000";

    const amountPerUnit = computeAmountPerUnit({ distributableNetEur, totalUnits });
    const entries = holders.map((holder) =>
      computeEntryAmount({ unitCount: holder.units, amountPerUnitEur: amountPerUnit }),
    );

    const sum = entries.reduce((total, entry) => total + Number(entry), 0);
    expect(sum).toBe(Number(distributableNetEur));
  });
});

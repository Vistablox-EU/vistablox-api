import { describe, expect, it } from "vitest";

import { materialityResetTriggered } from "../src/modules/offering/domain/materiality.policy.js";

describe("materialityResetTriggered", () => {
  it("always resets on a per_se_material classification", () => {
    expect(materialityResetTriggered("per_se_material")).toBe(true);
  });

  it("always resets on a reviewed_material classification", () => {
    expect(materialityResetTriggered("reviewed_material")).toBe(true);
  });

  it("never resets on a non_material classification", () => {
    expect(materialityResetTriggered("non_material")).toBe(false);
  });
});

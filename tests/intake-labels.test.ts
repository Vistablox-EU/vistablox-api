import { describe, expect, it } from "vitest";

import {
  displayLabel,
  intakeActionLabels,
  intakeStageLabels,
  labelsFor,
} from "../src/modules/intake/presentation/intake-labels.js";

describe("intake display labels", () => {
  it("maps every supported case stage to a stable English label", () => {
    expect(displayLabel("pre_offering_open", intakeStageLabels)).toBe("Pre-offering open");
    expect(Object.keys(intakeStageLabels)).toHaveLength(9);
  });

  it("preserves order for arrays of machine codes", () => {
    expect(labelsFor(["assign_partner", "close_case"], intakeActionLabels)).toEqual([
      "Assign partner",
      "Close case",
    ]);
  });

  it("falls back safely for a future code and handles null", () => {
    expect(displayLabel("future_status", intakeStageLabels)).toBe("Future Status");
    expect(displayLabel(null, intakeStageLabels)).toBeNull();
  });
});

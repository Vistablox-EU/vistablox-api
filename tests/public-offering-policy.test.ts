import { describe, expect, it } from "vitest";

import { isPublicOfferingStatus } from "../src/modules/offering/domain/public-offering.policy.js";

describe("public offering policy", () => {
  it.each([
    ["pre_offering", true],
    ["final_offering", true],
    ["closed", false],
    ["draft", false],
  ])("classifies %s", (status, expected) => {
    expect(isPublicOfferingStatus(status)).toBe(expected);
  });
});

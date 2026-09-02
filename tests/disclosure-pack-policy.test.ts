import { describe, expect, it } from "vitest";

import {
  disclosureDocumentTypes,
  isCompleteDisclosurePack,
  isCoreReadingDocumentType,
} from "../src/modules/offering/domain/disclosure-pack.policy.js";

describe("isCoreReadingDocumentType", () => {
  it("is core reading for every mandatory document except the full prospectus", () => {
    for (const documentType of disclosureDocumentTypes) {
      expect(isCoreReadingDocumentType(documentType)).toBe(documentType !== "full_prospectus");
    }
  });
});

describe("isCompleteDisclosurePack", () => {
  it("is complete once every mandatory document type is present", () => {
    expect(isCompleteDisclosurePack(disclosureDocumentTypes)).toBe(true);
  });

  it("is incomplete when even one mandatory document type is missing", () => {
    const missingFullProspectus = disclosureDocumentTypes.filter((type) => type !== "full_prospectus");
    expect(isCompleteDisclosurePack(missingFullProspectus)).toBe(false);
  });

  it("is incomplete for an empty set", () => {
    expect(isCompleteDisclosurePack([])).toBe(false);
  });
});

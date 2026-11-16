import { describe, expect, it } from "vitest";

import {
  disclosureDocumentTypes,
  isCompleteDisclosurePack,
  isCoreReadingDocumentType,
  requiredDisclosurePackVersionAfterReset,
  satisfiesRequiredDisclosurePackVersion,
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

describe("requiredDisclosurePackVersionAfterReset", () => {
  it("requires a version newer than the latest published one", () => {
    expect(requiredDisclosurePackVersionAfterReset(3)).toBe(4);
  });

  it("requires version 1 when no pack has been published", () => {
    expect(requiredDisclosurePackVersionAfterReset(null)).toBe(1);
  });
});

describe("satisfiesRequiredDisclosurePackVersion", () => {
  it("is satisfied when no materiality reset requires a version", () => {
    expect(satisfiesRequiredDisclosurePackVersion({ currentPackVersion: 1, requiredVersion: null })).toBe(true);
  });

  it("is satisfied by a current pack at or above the required version", () => {
    expect(satisfiesRequiredDisclosurePackVersion({ currentPackVersion: 4, requiredVersion: 4 })).toBe(true);
    expect(satisfiesRequiredDisclosurePackVersion({ currentPackVersion: 5, requiredVersion: 4 })).toBe(true);
  });

  it("is not satisfied by a pack published before the reset", () => {
    expect(satisfiesRequiredDisclosurePackVersion({ currentPackVersion: 3, requiredVersion: 4 })).toBe(false);
  });

  it("is not satisfied when there is no current pack but a version is required", () => {
    expect(satisfiesRequiredDisclosurePackVersion({ currentPackVersion: null, requiredVersion: 1 })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_STORAGE_BUCKETS, objectKey } from "../src/infrastructure/storage/storage-buckets.js";

describe("document storage boundaries", () => {
  it("keeps the stable bucket vocabulary", () => {
    expect(DEFAULT_STORAGE_BUCKETS).toEqual({
      quarantine: "vistablox-quarantine",
      private: "vistablox-private",
      kyc: "vistablox-kyc",
      disclosures: "vistablox-disclosures",
      audit: "vistablox-audit",
    });
  });

  it("creates opaque, revision-aware keys", () => {
    expect(objectKey({ area: "intake", subjectId: "case_01", revision: 2, documentId: "doc_01" }))
      .toBe("intake/case_01/revisions/2/doc_01");
    expect(() => objectKey({ area: "kyc", subjectId: "../account", documentId: "secret" })).toThrow();
  });

  it("accepts the upper-case ULIDs real offering and case ids embed", () => {
    expect(objectKey({ area: "offerings", subjectId: "offering_01M7AGKPB4F22YKF7Y3SJFB4W1", documentId: "doc_0a1b" }))
      .toBe("offerings/offering_01M7AGKPB4F22YKF7Y3SJFB4W1/doc_0a1b");
    expect(() => objectKey({ area: "offerings", subjectId: "offering 01", documentId: "doc_01" })).toThrow();
    expect(() => objectKey({ area: "offerings", subjectId: "offering_01", documentId: "doc/../01" })).toThrow();
  });
});

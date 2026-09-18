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
});

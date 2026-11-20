import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./support/without-comments.js";

// A service built without a logger swallows a failed object delete exactly as
// before, so the logger has to reach both services where they are built.
// src/server.ts is a start-up script that cannot be imported into a test, so
// it is read as text, the way tests/coinbase-onramp-webhook-wiring.test.ts
// does; src/app.ts is read the same way because building the offering
// upload service there needs the whole protected API. Comments are blanked
// out first so a commented-out argument does not count.
function flatSource(path: string): string {
  return withoutComments(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")).replace(/\s+/g, " ");
}

describe("object-delete logging wiring", () => {
  it("builds the intake upload service with the server's logger", () => {
    expect(flatSource("../src/server.ts")).toMatch(
      /new UploadCaseDocumentService\( database, new S3Client\(\{.*?\}\), environment\.MINIO_PRIVATE_BUCKET, malwareScanner, logger, \)/,
    );
  });

  it("builds the offering upload service with the app's logger", () => {
    expect(flatSource("../src/app.ts")).toContain(
      "new UploadOfferingDocumentService(offeringDocuments.repository, offeringDocuments.store, offeringDocuments.scanner, undefined, dependencies.logger)",
    );
  });
});

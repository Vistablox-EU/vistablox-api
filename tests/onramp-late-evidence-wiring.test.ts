import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./support/without-comments.js";

// src/worker.ts, src/server.ts and src/app.ts are start-up scripts and wiring
// that cannot be imported into a test, so what they connect is checked from
// their source, the way tests/coinbase-onramp-webhook-wiring.test.ts does.
// What nothing else covers is that the late-evidence pieces are connected at
// all: without the handler the poll and the webhook job only log a late
// success; without the job the standing alert never fires; without the mount
// the staff list answers 404. tsc notices none of them.
function load(path: string): { code: string; flat: string } {
  const code = withoutComments(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
  return { code, flat: code.replace(/\s+/g, " ") };
}

const server = load("../src/server.ts");
const app = load("../src/app.ts");

describe("late onramp evidence wiring in the API", () => {
  it("builds the staff repository over the database and passes it to createApp", () => {
    expect(server.flat).toContain(
      "onrampLateEvidence: { repository: new PrismaOnrampLateEvidenceRepository(database) },",
    );
  });

  it("mounts the staff router under the offerings prefix, ahead of the offering-operations router that owns /:offering_id", () => {
    const mount = app.code.indexOf('"/internal/v1/offerings/onramp-late-evidence"');
    const operations = app.code.indexOf('"/internal/v1/offerings",');
    expect(mount).toBeGreaterThan(-1);
    expect(operations).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(operations);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./support/without-comments.js";

// The watcher heartbeat is one platform.settings row, and the integration test
// files all run in parallel against one database. The health integration test
// deletes that row and then asserts that it reads as missing, or holds one
// value; a second file that also upserts it can land between those two steps
// and fail the assertion, with nothing in the failure pointing at the other
// file. So the row has exactly one owner among the integration tests, and every
// other test that runs the reporter passes it a writer of its own.
//
// What counts as writing the row for real: constructing the Prisma health
// repository (its recordWatcherHeartbeat is the only code that touches the
// row), or naming the key. Comments are blanked out first, so a comment that
// explains why a file does not do this is not a violation.
const OWNER = "wallet-registry-health.integration.test.ts";
const testsDirectory = fileURLToPath(new URL(".", import.meta.url));

const integrationFiles = readdirSync(testsDirectory).filter((name) => name.endsWith(".integration.test.ts"));

function touchesTheHeartbeatRow(name: string): boolean {
  const source = withoutComments(readFileSync(`${testsDirectory}${name}`, "utf8"));
  return source.includes("PrismaWalletRegistryHealthRepository") || source.includes("wallet_registry.watcher_heartbeat");
}

describe("the wallet-registry heartbeat row in the integration tests", () => {
  it("is touched by the health integration test only", () => {
    expect(integrationFiles).toContain(OWNER);
    expect(integrationFiles.filter(touchesTheHeartbeatRow)).toEqual([OWNER]);
  });
});

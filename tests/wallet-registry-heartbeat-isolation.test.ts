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

// The watcher's cursor is the second row the health integration test reads (a
// saved cursor is part of "the watcher has run before") and deletes. Same
// hazard, same remedy. Naming the key is not the only way to write it for real:
// the settlement repository's own cursor methods do. So an integration file
// that builds the confirmation service on the real settlement repository must
// replace those two methods with its own, as the three that do today do.
describe("the wallet-registry cursor row in the integration tests", () => {
  const CURSOR_KEY = "wallet_registry.last_processed_block";

  function readsSource(name: string): string {
    return withoutComments(readFileSync(`${testsDirectory}${name}`, "utf8"));
  }

  it("is named by the health integration test only", () => {
    expect(integrationFiles.filter((name) => readsSource(name).includes(CURSOR_KEY))).toEqual([OWNER]);
  });

  it("is never written by an integration file that runs the watcher on the real settlement repository", () => {
    const runsTheWatcherForReal = integrationFiles.filter((name) => {
      const source = readsSource(name);
      return (
        source.includes("PrismaSettlementRepository") &&
        (source.includes("ConfirmWalletRegistrationsService") || source.includes("RunWalletRegistryWatcherService"))
      );
    });

    expect(runsTheWatcherForReal.length).toBeGreaterThan(0);
    for (const name of runsTheWatcherForReal) {
      const source = readsSource(name);
      expect(source, name).toContain("getLastProcessedWalletRegistryBlock");
      expect(source, name).toContain("setLastProcessedWalletRegistryBlock");
    }
  });
});

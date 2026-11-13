import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function sourceOf(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
}

// The variables that tune the wallet-registry alerts, with the default each
// must carry everywhere it is listed. A new variable reaches the containers
// only if the &app-environment anchor passes it, which is exactly the kind of
// thing that is forgotten, so the three places are checked against each other.
const ALERT_VARIABLES = {
  WALLET_REGISTRY_PENDING_WARN_AFTER_MINUTES: "5",
  WALLET_REGISTRY_WATCHER_STALE_AFTER_MINUTES: "10",
  WALLET_REGISTRY_CURSOR_LAG_ALERT_BLOCKS: "900",
  WALLET_REGISTRY_PENDING_OVERDUE_ALERT_COUNT: "1",
  WALLET_REGISTRY_UNMATCHED_EVENTS_ALERT_COUNT: "5",
} as const;

// The lines of the `environment: &app-environment` mapping: everything under
// the anchor that is indented deeper than the key itself.
function appEnvironmentBlock(compose: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => line.includes("&app-environment"));
  expect(start).toBeGreaterThan(-1);
  const keyIndent = (lines[start]!.match(/^ */) ?? [""])[0].length;
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && (line.match(/^ */) ?? [""])[0].length <= keyIndent) break;
    block.push(line);
  }
  return block.join("\n");
}

describe("wallet registry alert configuration", () => {
  const environmentSource = sourceOf("src/config/environment.ts");
  const envExample = sourceOf(".env.example");
  const appEnvironment = appEnvironmentBlock(sourceOf("docker-compose.staging.yml"));

  it.each(Object.entries(ALERT_VARIABLES))("%s is declared, documented in .env.example and passed by the staging anchor", (name, fallback) => {
    expect(environmentSource).toContain(`${name}:`);
    expect(envExample).toMatch(new RegExp(`^${name}=${fallback}$`, "m"));
    expect(appEnvironment).toContain(`${name}: \${${name}:-${fallback}}`);
  });

  it("finds the anchor block it is checking", () => {
    // Guards the helper: an empty block would make every anchor check fail for
    // the wrong reason, and an unbounded one would make them pass for it.
    expect(appEnvironment).toContain("DATABASE_URL:");
    expect(appEnvironment).toContain("VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS:");
    expect(appEnvironment).not.toContain("depends_on");
    expect(appEnvironment).not.toContain("healthcheck");
  });
});

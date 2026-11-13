import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  WALLET_REGISTRY_ALERT_EVENTS,
  evaluateWalletRegistryHealth,
  evaluateWalletRegistryRun,
  type WalletRegistryAlertThresholds,
  type WalletRegistryHealthSnapshot,
} from "../src/modules/settlement/domain/wallet-registry-alert-policy.js";

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

// The runbook is what an operator reads at the moment an event fires, so the
// names, severities and fields in it are checked against the code that emits
// them, the way the variables above are.
describe("wallet registration runbook", () => {
  const runbook = sourceOf("docs/wallet-registration-operations.md");

  // Severity each event is documented with in the runbook's table; the policy
  // tests pin what the policy actually raises.
  const DOCUMENTED_SEVERITY: Record<string, string> = {
    "wallet_registry.address_mismatch": "error",
    "wallet_registry.watcher_stalled": "error",
    "wallet_registry.cursor_lag": "error",
    "wallet_registry.cursor_ahead_of_chain": "error",
    "wallet_registry.watcher_not_configured": "error with pending claims, warn without",
    "wallet_registry.health_check_failed": "error",
    "wallet_registry.watcher_failed": "warn",
    "wallet_registry.heartbeat_write_failed": "warn",
    "wallet_registry.pending_overdue": "warn",
    "wallet_registry.unmatched_events": "warn",
    "wallet_registry.address_mismatch_unresolved": "warn",
    "wallet_registry.health_checked": "info",
  };

  it("documents every event the code can emit, and nothing it cannot", () => {
    expect(Object.keys(DOCUMENTED_SEVERITY).sort()).toEqual([...Object.values(WALLET_REGISTRY_ALERT_EVENTS)].sort());
  });

  it.each(Object.entries(DOCUMENTED_SEVERITY))("%s has a table row with severity %s", (event, severity) => {
    const row = runbook.split("\n").find((line) => line.startsWith(`| \`${event}\` |`));

    expect(row).toBeDefined();
    expect((row ?? "").split("|")[2]?.trim()).toBe(severity);
  });

  it.each(Object.keys(ALERT_VARIABLES))("mentions %s", (name) => {
    expect(runbook).toContain(`\`${name}\``);
  });

  it("documents every field of every alert the policy can raise", () => {
    const thresholds: WalletRegistryAlertThresholds = {
      watcherStaleAfterMs: 600_000,
      cursorLagAlertBlocks: 900n,
      cursorAheadToleranceBlocks: 32n,
      pendingOverdueAlertCount: 1,
      unmatchedEventsAlertCount: 5,
    };
    const now = new Date("2026-11-13T12:00:00.000Z");
    const base: WalletRegistryHealthSnapshot = {
      watcherConfigured: true,
      workerStartedAt: new Date(now.getTime() - 3_600_000),
      heartbeat: { completedAt: new Date(now.getTime() - 3_600_000), cursorBlock: 0n, safeHeadBlock: 5000n, eventsFound: 0 },
      pendingTotal: 3,
      pendingOverdue: 3,
      oldestPendingRequestedAt: new Date(now.getTime() - 3_600_000),
      unresolvedMismatchCount: 1,
      unresolvedMismatchAccountIds: ["acct_a"],
    };
    const alerts = [
      ...evaluateWalletRegistryHealth(base, thresholds, now),
      ...evaluateWalletRegistryHealth({ ...base, heartbeat: { ...base.heartbeat!, cursorBlock: 6000n } }, thresholds, now),
      ...evaluateWalletRegistryHealth({ ...base, watcherConfigured: false }, thresholds, now),
      ...evaluateWalletRegistryRun({ newUnmatchedEvents: 9 }, thresholds),
    ];

    // Every health and run event the policy raises is in the set under test.
    expect(new Set(alerts.map((alert) => alert.event))).toEqual(
      new Set([
        "wallet_registry.watcher_stalled",
        "wallet_registry.cursor_lag",
        "wallet_registry.cursor_ahead_of_chain",
        "wallet_registry.watcher_not_configured",
        "wallet_registry.pending_overdue",
        "wallet_registry.address_mismatch_unresolved",
        "wallet_registry.unmatched_events",
      ]),
    );
    for (const alert of alerts) {
      const row = runbook.split("\n").find((line) => line.startsWith(`| \`${alert.event}\` |`)) ?? "";
      for (const field of Object.keys(alert.details)) {
        expect([alert.event, field, row.includes(`\`${field}\``)]).toEqual([alert.event, field, true]);
      }
    }
  });

  it("never contains a full wallet address, commitment or other long hex value", () => {
    expect(runbook).not.toMatch(/0x[0-9a-fA-F]{12,}/);
  });

  it("is linked from the README and from the investor-profile doc", () => {
    expect(sourceOf("README.md")).toContain("docs/wallet-registration-operations.md");
    expect(sourceOf("docs/investor-profile.md")).toContain("wallet-registration-operations.md");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./support/without-comments.js";

// src/worker.ts is a start-up script that cannot be imported into a test, so
// what it wires up is checked from its source, the way tests/job-queues.test.ts
// does for queues in general. Behaviour of what it wires is covered by the
// service and reporter tests.
//
// Comments are blanked out first: a call that has been commented out must not
// satisfy a check for the call. `flat` is the same code with every run of
// whitespace collapsed to one space, for checks that pin a whole statement.
const worker = withoutComments(readFileSync(fileURLToPath(new URL("../src/worker.ts", import.meta.url)), "utf8"));
const flat = worker.replace(/\s+/g, " ");

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// The text of one `await boss.work("<name>", async () => { ... });` call, from
// `boss.work` to the closing brace of the handler.
function handlerOf(name: string): string {
  const start = worker.indexOf(`boss.work("${name}"`);
  expect(start).toBeGreaterThan(-1);
  const end = worker.indexOf("\n  });", start);
  expect(end).toBeGreaterThan(start);
  return worker.slice(start, end);
}

describe("wallet-registry worker wiring", () => {
  it("creates the health queue as a scheduled queue, when the health check exists", () => {
    expect(flat).toContain(
      'if (checkWalletRegistryHealth !== undefined) { await ensureJobQueue(boss, "settlement.check_wallet_registry_health", "scheduled"); }',
    );
  });

  it("schedules the health check every 5 minutes on the scheduled retry profile, when the health check exists", () => {
    expect(flat).toMatch(
      new RegExp(
        `if \\(checkWalletRegistryHealth !== undefined\\) \\{ await boss\\.schedule\\("settlement\\.check_wallet_registry_health", "${escape("*/5 * * * *")}", null, \\{[^}]*\\.\\.\\.RETRY_OPTIONS`,
      ),
    );
  });

  it("schedules the watcher every minute, when the watcher exists", () => {
    expect(flat).toMatch(
      new RegExp(
        `if \\(confirmWalletRegistrations !== undefined\\) \\{ await boss\\.schedule\\("settlement\\.confirm_wallet_registrations", "${escape("* * * * *")}", null, \\{[^}]*\\.\\.\\.RETRY_OPTIONS`,
      ),
    );
  });

  it("consumes the health queue with a literal boss.work, so the queue test can see it", () => {
    expect(worker).toContain('boss.work("settlement.check_wallet_registry_health"');
  });

  it("gates the health check on the registry address alone, so a missing CHAIN_* bundle is reportable", () => {
    const gate = worker.match(/const walletRegistryHealthRepository =([\s\S]*?);\n/)?.[1] ?? "";

    expect(gate).toContain("environment.VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS === undefined");
    expect(gate).not.toContain("chainClients");
    // And it learns whether the watcher itself exists from the watcher's own gate.
    expect(worker).toContain("watcherConfigured: confirmWalletRegistrations !== undefined");
  });

  it("measures a cursor that is ahead of the chain against the watcher's own overlap", () => {
    expect(worker).toContain("cursorAheadToleranceBlocks: WALLET_REGISTRY_RESCAN_OVERLAP_BLOCKS");
  });

  it("wires every threshold from the environment", () => {
    for (const name of [
      "WALLET_REGISTRY_WATCHER_STALE_AFTER_MINUTES",
      "WALLET_REGISTRY_CURSOR_LAG_ALERT_BLOCKS",
      "WALLET_REGISTRY_PENDING_OVERDUE_ALERT_COUNT",
      "WALLET_REGISTRY_UNMATCHED_EVENTS_ALERT_COUNT",
      "WALLET_REGISTRY_PENDING_WARN_AFTER_MINUTES",
    ]) {
      expect(worker).toContain(`environment.${name}`);
    }
  });

  it.each([
    ["settlement.confirm_wallet_registrations", "runWalletRegistryWatcher"],
    ["settlement.check_wallet_registry_health", "checkWalletRegistryHealth"],
  ])("%s is consumed by a handler that only delegates to its service, and never logs the raw error", (name, service) => {
    const body = handlerOf(name).replace(/\s+/g, " ");

    // Exactly one statement: the call, awaited, so its failure fails the job.
    expect(body).toBe(`boss.work("${name}", async () => { await ${service}.execute();`);
    // A viem error logged as { err } carries the RPC URL and its provider key;
    // the reporter logs a sanitised message instead.
    expect(body).not.toContain("err:");
    expect(body).not.toContain("logger.");
    expect(body).not.toContain("catch");
  });

  it.each([
    ["settlement.confirm_wallet_registrations", "runWalletRegistryWatcher"],
    ["settlement.check_wallet_registry_health", "checkWalletRegistryHealth"],
  ])("registers the %s handler only where its service exists", (name, service) => {
    expect(flat).toContain(`if (${service} !== undefined) {`);
    expect(flat).toMatch(new RegExp(`if \\(${service} !== undefined\\) \\{[^}]*?await boss\\.work\\("${escape(name)}"`));
  });
});

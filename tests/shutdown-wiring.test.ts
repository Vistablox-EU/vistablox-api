import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_SHUTDOWN_DEADLINE_MS } from "../src/shared/lifecycle/graceful-shutdown.js";
import { withoutComments } from "./support/without-comments.js";

// src/server.ts and src/worker.ts are start-up scripts that cannot be imported
// into a test, so what they wire up is checked from their source, the way
// tests/wallet-registry-worker-wiring.test.ts does. What the wired pieces do is
// covered by graceful-shutdown.test.ts and pg-pool-error-listener.test.ts.
// Comments are blanked out first so a commented-out call cannot satisfy a check.
const sourceOf = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const code = (path: string): string => withoutComments(sourceOf(path)).replace(/\s+/g, " ");

describe("process lifecycle wiring", () => {
  it.each(["src/server.ts", "src/worker.ts"])("%s shuts down through the shared function, on both signals", (path) => {
    const source = code(path);

    expect(source).toContain("const shutdown = createGracefulShutdown({ logger,");
    expect(source).toContain('process.on("SIGINT", () => void shutdown("SIGINT"));');
    expect(source).toContain('process.on("SIGTERM", () => void shutdown("SIGTERM"));');
    // `once` would hand a second signal back to Node's default and kill the
    // process in the middle of the shutdown.
    expect(source).not.toContain("process.once(");
    expect(source).not.toMatch(/function shutdown\b/);
  });

  it.each(["src/server.ts", "src/worker.ts"])("%s logs and shuts down on an uncaught exception or unhandled rejection", (path) => {
    expect(code(path)).toContain("installProcessFaultHandlers({ logger, shutdown });");
  });

  it("builds Better Auth's pool with createPgPool, so an idle client error is logged, not thrown", () => {
    const server = code("src/server.ts");

    expect(server).toContain(
      'const authDatabase = createPgPool({ connectionString: environment.DATABASE_URL }, logger, "better-auth");',
    );
    expect(server).not.toMatch(/new Pool\(/);
  });

  it("closes the HTTP server before the database, and the Better Auth pool with everything else", () => {
    const server = code("src/server.ts");
    const http = server.indexOf('name: "http server"');
    const database = server.indexOf('name: "prisma client"');

    expect(http).toBeGreaterThan(-1);
    expect(database).toBeGreaterThan(http);
    for (const step of ["better-auth database pool", "pg-boss", "rate limit cache", "protected profile cache"]) {
      expect(server.indexOf(`name: "${step}"`)).toBeGreaterThan(http);
    }
  });

  it("stops pg-boss in the worker with a bound, before the Prisma client its jobs use is closed", () => {
    const worker = code("src/worker.ts");
    const boss = worker.indexOf('name: "pg-boss"');
    const database = worker.indexOf('name: "prisma client"');

    expect(worker).toContain("boss.stop({ graceful: true, timeout: JOB_DRAIN_TIMEOUT_MS })");
    expect(boss).toBeGreaterThan(-1);
    expect(database).toBeGreaterThan(boss);
    // Stopped in a step of its own, so a failure there cannot skip the pg-boss stop.
    expect(worker).toContain('{ name: "health probe", close: () => heartbeat.stop() }');
  });
});

// The body of one service in a compose file: from its `  name:` line to the
// next line indented by two spaces only.
function serviceBlock(file: string, name: string): string {
  const lines = sourceOf(file).split("\n");
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `${file} has a ${name} service`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("stop_grace_period", () => {
  const services: Array<[string, string]> = [
    ["docker-compose.yml", "api"],
    ["docker-compose.yml", "worker"],
    ["docker-compose.staging.yml", "vistablox-api"],
    ["docker-compose.staging.yml", "worker"],
  ];

  it.each(services)("%s: %s gets longer to stop than the process gives itself to close down", (file, name) => {
    const match = /^ {4}stop_grace_period: (\d+)s$/m.exec(serviceBlock(file, name));

    expect(match, `${file} ${name} sets stop_grace_period in whole seconds`).not.toBeNull();
    expect(Number(match?.[1]) * 1_000).toBeGreaterThan(DEFAULT_SHUTDOWN_DEADLINE_MS);
  });

  it("finds the service blocks it is checking", () => {
    // Guards the helper: a block that swallowed the rest of the file would let
    // every check above pass for the wrong service.
    expect(serviceBlock("docker-compose.staging.yml", "worker")).not.toContain("vistablox-api:");
    expect(serviceBlock("docker-compose.staging.yml", "vistablox-api")).not.toContain("worker:");
    expect(serviceBlock("docker-compose.yml", "api")).not.toContain("worker:");
  });
});

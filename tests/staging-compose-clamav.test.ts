import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const compose = readFileSync(
  fileURLToPath(new URL("../docker-compose.staging.yml", import.meta.url)),
  "utf8",
);

// The lines of the `environment: &app-environment` mapping.
function appEnvironmentBlock(): string {
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

describe("staging compose ClamAV configuration", () => {
  it("passes CLAMAV_HOST and CLAMAV_PORT to the app containers with defaults", () => {
    const block = appEnvironmentBlock();
    expect(block).toContain("CLAMAV_HOST: ${CLAMAV_HOST:-clamav}");
    expect(block).toContain("CLAMAV_PORT: ${CLAMAV_PORT:-3310}");
  });

  it("does not set ClamAV variables on storage-init, which never scans", () => {
    const storageInit = compose.slice(compose.indexOf("  storage-init:"), compose.indexOf("  migrate:"));
    expect(storageInit).not.toContain("CLAMAV_");
  });
});

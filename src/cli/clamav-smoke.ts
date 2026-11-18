/**
 * Checks the API's ClamAV scanner against a real clamd: clean data must come
 * back clean and the EICAR test string must come back infected.
 *
 *   CLAMAV_HOST=127.0.0.1 CLAMAV_PORT=3310 npm run clamav:smoke
 *
 * Not part of `npm test` or `npm run check`: it needs a running clamd with a
 * signature database (the compose `clamav` service, see docs/document-storage.md),
 * and a test that skipped itself without one would trip CI's skipped-test guard.
 * Run it by hand after changing the scanner or the pinned clamd image, and from
 * the API container (where the container's own CLAMAV_HOST is read) to prove
 * the deployed wiring.
 *
 * Reads CLAMAV_HOST (default 127.0.0.1) and CLAMAV_PORT (default 3310) the way
 * src/server.ts does, and prints the target it used.
 *
 * Exit codes: 0 every check passed, 1 a check failed or clamd was unreachable,
 * 2 bad configuration.
 */
import { ClamAvScanner } from "../infrastructure/antivirus/clamav-scanner.js";
import { runClamavSmoke } from "./clamav-smoke-checks.js";

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const SCAN_TIMEOUT_MS = 30_000;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const host = process.env.CLAMAV_HOST === undefined || process.env.CLAMAV_HOST === "" ? "127.0.0.1" : process.env.CLAMAV_HOST;
  const port = Number(process.env.CLAMAV_PORT === undefined || process.env.CLAMAV_PORT === "" ? "3310" : process.env.CLAMAV_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    process.stderr.write(`Error: CLAMAV_PORT must be an integer from 1 to 65535, got "${process.env.CLAMAV_PORT}".\n`);
    return EXIT_USAGE;
  }

  print(`ClamAV smoke check against ${host}:${port}`);
  const passed = await runClamavSmoke(new ClamAvScanner(host, port, SCAN_TIMEOUT_MS), print);
  print(passed ? "All checks passed." : "At least one check failed.");
  return passed ? 0 : EXIT_FAILED;
}

process.exit(await main());

import type { MalwareScanner } from "../infrastructure/antivirus/clamav-scanner.js";

// The EICAR antivirus test file (https://www.eicar.org/): a harmless 68-byte
// string every scanner reports as a virus. It is assembled from two halves so
// that this source file is not itself flagged by a scanner reading the repo.
const EICAR_HEAD = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$";
const EICAR_TAIL = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
export const EICAR_TEST_STRING = `${EICAR_HEAD}${EICAR_TAIL}`;

export interface ClamavSmokeCheck {
  name: string;
  data: Buffer;
  expected: "clean" | "infected";
}

/** Larger than one 64 KiB INSTREAM chunk, so a stream of several chunks is exercised too. */
const CLEAN_PADDING_BYTES = 200 * 1024;

// ClamAV matches EICAR as a whole-file signature (68 bytes, nothing before or
// after it), so the infected case is the bare string; it cannot be padded to
// span several chunks. The multi-chunk case is the clean 200 KiB buffer, which
// clamd answers "OK" only if every chunk's framing was read correctly.
export const CLAMAV_SMOKE_CHECKS: readonly ClamavSmokeCheck[] = [
  { name: "clean text", data: Buffer.from("a harmless document\n"), expected: "clean" },
  { name: "clean 200 KiB (several chunks)", data: Buffer.alloc(CLEAN_PADDING_BYTES, 0x41), expected: "clean" },
  { name: "EICAR test string", data: Buffer.from(EICAR_TEST_STRING, "latin1"), expected: "infected" },
];

/**
 * Runs every check against the scanner and reports one line each through
 * `report`. Returns true only if every check got its expected verdict; a
 * scanner that throws counts as a failure, never as a pass.
 */
export async function runClamavSmoke(scanner: MalwareScanner, report: (line: string) => void): Promise<boolean> {
  let allPassed = true;
  for (const check of CLAMAV_SMOKE_CHECKS) {
    try {
      const verdict = await scanner.scan(check.data);
      if (verdict === check.expected) {
        report(`PASS  ${check.name}: ${verdict}`);
      } else {
        allPassed = false;
        report(`FAIL  ${check.name}: expected ${check.expected}, got ${verdict}`);
      }
    } catch (error) {
      allPassed = false;
      report(`FAIL  ${check.name}: scanner error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return allPassed;
}

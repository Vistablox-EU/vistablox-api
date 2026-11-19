import { describe, expect, it } from "vitest";
import { ClamAvScanner } from "../src/infrastructure/antivirus/clamav-scanner.js";

// Runs against a real clamd, e.g. `docker run -p 3310:3310 clamav/clamav`.
// Set CLAMAV_TEST_HOST (and optionally CLAMAV_TEST_PORT, default 3310) to enable.
const host = process.env.CLAMAV_TEST_HOST;
const port = Number(process.env.CLAMAV_TEST_PORT ?? 3310);

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

describe.skipIf(!host)("ClamAvScanner against a real clamd", () => {
  const scanner = new ClamAvScanner(host ?? "", port);

  it("reports clean content as clean", async () => {
    await expect(scanner.scan(Buffer.from("just a harmless document"))).resolves.toBe("clean");
  });

  it("reports the EICAR test file as infected", async () => {
    await expect(scanner.scan(Buffer.from(EICAR))).resolves.toBe("infected");
  });

  it("scans payloads larger than one chunk", async () => {
    await expect(scanner.scan(Buffer.alloc(200 * 1024, 0x61))).resolves.toBe("clean");
  });
});

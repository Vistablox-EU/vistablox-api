import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import express from "express";
import nodemailer from "nodemailer";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createStaffDraftSubmitBodySchema } from "../src/modules/intake/api/intake-operations.schemas.js";

// Each case below fails on the dependency version that carries the advisory
// and passes on the version that fixes it. They exercise the dependency the
// way this application uses it, so a lockfile that slips back to an affected
// version shows up as a failing test and not only in `npm audit`.

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function expressTrusts(trustProxy: string[], address: string): boolean {
  const app = express();
  app.set("trust proxy", trustProxy);
  const trust = app.get("trust proxy fn") as (address: string, hop: number) => boolean;
  return trust(address, 0);
}

// proxy-addr, which Express compiles `trust proxy` with, up to 2.0.7 turned an
// IPv4-mapped IPv6 subnet with a short prefix (and any IPv6 subnet with zero
// leading bits) into one that matched every IPv4 address, so any caller was
// believed when it sent X-Forwarded-For. parseTrustProxy already refuses these
// values (tests/trust-proxy-environment.test.ts); this keeps the guarantee from
// resting on that validator alone.
describe("trust proxy subnets (GHSA-jqcg-44mw-7w3h, proxy-addr < 2.0.8)", () => {
  it.each(["::ffff:10.0.0.0/8", "::ffff:10.0.0.0/16", "::/1"])(
    "does not let the subnet %s trust a public IPv4 peer",
    (subnet) => {
      expect(expressTrusts([subnet], "203.0.113.9")).toBe(false);
      expect(expressTrusts([subnet], "8.8.8.8")).toBe(false);
    },
  );

  it("still trusts exactly the peers a correctly written subnet names", () => {
    expect(expressTrusts(["10.0.0.0/8"], "10.1.2.3")).toBe(true);
    expect(expressTrusts(["10.0.0.0/8"], "203.0.113.9")).toBe(false);
    expect(expressTrusts(["::ffff:10.0.0.0/104"], "10.1.2.3")).toBe(true);
    expect(expressTrusts(["::ffff:10.0.0.0/104"], "203.0.113.9")).toBe(false);
  });

  it("keeps req.ip at the connecting address when a client sends X-Forwarded-For", async () => {
    const app = express();
    app.set("trust proxy", ["::ffff:10.0.0.0/8"]);
    app.get("/ip", (req, res) => {
      res.json({ ip: req.ip });
    });

    const response = await request(app).get("/ip").set("x-forwarded-for", "203.0.113.9");

    expect(response.body).toEqual({ ip: expect.not.stringContaining("203.0.113.9") });
  });
});

// body-parser up to 2.3.0 left the gunzip stream piped with no error listener
// after it had read the body, so bytes arriving after the end of the gzip data
// raised an unhandled "error" and ended the process, before routing and
// authentication. The scenario runs in a process of its own: see the fixture.
describe("compressed request body followed by extra bytes (GHSA-27r3-jxmh-p828, body-parser < 2.4.0)", () => {
  it("is answered and the server keeps serving", { timeout: 60_000 }, async () => {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "tests/support/gzip-trailing-bytes-server.ts"],
      { cwd: repositoryRoot, timeout: 50_000 },
    ).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number | string; stdout?: string; stderr?: string }) => ({
        code: error.code ?? "unknown",
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      }),
    );

    expect(result.code, result.stderr.slice(0, 600)).toBe(0);
    // The JSON inside the gzip data was read, and POST /v1/offerings has no
    // route, so it ends in the 404 handler; the server then answers a GET.
    expect(JSON.parse(result.stdout)).toEqual({ withExtraBytes: 404, afterwards: 200 });
  });
});

// zod 4.5 and earlier recorded one issue per failing element before looking at
// an array's length bounds, so an array that fits in the 1 MB JSON limit and
// breaks a .max() made the process allocate a record per element
// (200,001 issues, about 145 MB of heap, for 200,000 elements).
describe("oversized constrained arrays (GHSA-mrhx-c7xc-m3w5, zod < 4.6.6)", () => {
  it("are rejected on their length without one issue per element", () => {
    const result = createStaffDraftSubmitBodySchema.safeParse({
      intake_terms_accepted: true,
      one_title_confirmed: true,
      submission_data: { note: "x" },
      documents: new Array<number>(200_000).fill(1),
    });

    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues.length).toBeLessThan(100);
    expect(issues[0]?.path).toEqual(["documents"]);
  });
});

// nodemailer parses every recipient with addressparser while it builds a
// message (SmtpEmailSender.sendMail does exactly this with the address from the
// account). Up to 10.0.5 and 10.0.4 two shapes of input took quadratic time:
// about 7 s for 400 KB of comment-joined addresses and about 5 s for 40 KB of
// dotted text with no address in it, each blocking the event loop.
describe("recipient parsing time (GHSA-prgh-xp8r-p3m5, GHSA-v53p-9fqp-m79j, nodemailer < 10.0.6)", () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });

  async function secondsToCompose(to: string): Promise<number> {
    const started = performance.now();
    await transport
      .sendMail({ from: "no-reply@example.com", to, subject: "Subject", text: "Text" })
      .catch(() => undefined);
    return (performance.now() - started) / 1000;
  }

  it.each([
    ["comment-joined addresses", `a@b${"(c)@b".repeat(80_000)}`],
    ["dotted text that holds no address", "a.".repeat(20_000)],
  ])("composes a message to %s in well under a second", { timeout: 60_000 }, async (_name, to) => {
    expect(await secondsToCompose(to)).toBeLessThan(1);
  });
});

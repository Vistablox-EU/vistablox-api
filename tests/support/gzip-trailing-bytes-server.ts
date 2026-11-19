// Run as its own process by tests/dependency-advisories.test.ts (node --import
// tsx), not by vitest. It starts the real createApp on a free port, posts a
// gzip request body that is followed by extra bytes, and then asks the server
// for a route that exists.
//
// It lives in a process of its own because of what body-parser 2.3.0 does with
// the extra bytes (GHSA-27r3-jxmh-p828): once the JSON has been read they are
// still piped into the gunzip stream, which has no error listener left, so the
// stream's "error" event (Z_DATA_ERROR) is thrown as an uncaught exception and
// ends the process. Inside vitest that would be reported as an unhandled error
// against the whole run instead of failing one test.
//
// The body is the shape body-parser's own regression test uses: one valid gzip
// stream, a zero byte, then 100 KiB of filler, in one request with a
// Content-Length. Prints one JSON line when the server is still up afterwards.
import { request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

import pino from "pino";

import { createApp } from "../../src/app.js";

const app = createApp({
  databaseProbe: { check: () => Promise.resolve() },
  offeringRepository: {
    listPublic: () => Promise.resolve([]),
    getInvestorDetail: () => Promise.resolve(null),
  },
  logger: pino({ level: "silent" }),
  corsOrigins: [],
});

function send(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string> },
  body?: Buffer,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const clientRequest = request({ host: "127.0.0.1", port, ...options }, resolve);
    clientRequest.on("error", reject);
    clientRequest.end(body);
  });
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const server = app.listen(0, "127.0.0.1", () => {
  void (async () => {
    const { port } = server.address() as AddressInfo;
    const body = Buffer.concat([
      gzipSync(JSON.stringify({ ok: true })),
      Buffer.from([0x00]),
      Buffer.alloc(100 * 1024, 0x58),
    ]);

    const withExtraBytes = await send(
      port,
      {
        method: "POST",
        path: "/v1/offerings",
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": String(body.length),
        },
      },
      body,
    );
    withExtraBytes.resume();

    // The crash comes from the extra bytes arriving after the body was read,
    // so give it time to happen before asking whether the server is still up.
    await pause(300);
    const afterwards = await send(port, { method: "GET", path: "/v1/offerings" });
    afterwards.resume();

    process.stdout.write(
      `${JSON.stringify({ withExtraBytes: withExtraBytes.statusCode, afterwards: afterwards.statusCode })}\n`,
    );
    server.close();
    process.exit(0);
  })();
});

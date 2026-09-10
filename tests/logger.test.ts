import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "../src/infrastructure/logging/logger.js";

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { logger: createLogger("info", destination), lines };
}

describe("createLogger redaction", () => {
  it("censors the session token better-auth returns in set-auth-token", () => {
    const { logger, lines } = captureLogger();

    logger.info(
      { res: { statusCode: 200, headers: { "set-auth-token": "session-token.signature" } } },
      "request completed",
    );

    expect(JSON.parse(lines[0] ?? "{}").res.headers["set-auth-token"]).toBe("[REDACTED]");
    expect(lines[0]).not.toContain("session-token.signature");
  });

  it("keeps censoring request credentials and set-cookie", () => {
    const { logger, lines } = captureLogger();

    logger.info(
      {
        req: { headers: { authorization: "Bearer secret-token", cookie: "session=secret" } },
        res: { headers: { "set-cookie": "session=secret" } },
      },
      "request completed",
    );

    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry.req.headers.authorization).toBe("[REDACTED]");
    expect(entry.req.headers.cookie).toBe("[REDACTED]");
    expect(entry.res.headers["set-cookie"]).toBe("[REDACTED]");
    expect(lines[0]).not.toContain("secret");
  });
});

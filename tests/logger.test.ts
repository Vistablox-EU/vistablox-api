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

  it("censors the filename of an upload, which can be a person's name", () => {
    const { logger, lines } = captureLogger();

    logger.info(
      {
        req: {
          headers: {
            "x-original-filename": "Jane Doe - Passport.pdf",
            "x-document-type": "ownership_declaration",
          },
        },
      },
      "request completed",
    );

    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry.req.headers["x-original-filename"]).toBe("[REDACTED]");
    expect(entry.req.headers["x-document-type"]).toBe("ownership_declaration");
    expect(lines[0]).not.toContain("Jane Doe");
  });

  it("censors the DPoP proof, a device-signed assertion that carries the device public key", () => {
    const { logger, lines } = captureLogger();

    logger.info(
      { req: { headers: { dpop: "eyJ0eXAiOiJkcG9wK2p3dCJ9.proof-body.proof-signature" } } },
      "request completed",
    );

    expect(JSON.parse(lines[0] ?? "{}").req.headers.dpop).toBe("[REDACTED]");
    expect(lines[0]).not.toContain("proof-body");
  });

  it("keeps the client address, forwarded chain and user agent, which are logged on purpose", () => {
    const { logger, lines } = captureLogger();

    logger.info(
      {
        req: {
          remoteAddress: "10.0.0.2",
          headers: { "x-forwarded-for": "203.0.113.7", "user-agent": "vistablox-test/1.0" },
        },
      },
      "request completed",
    );

    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry.req.remoteAddress).toBe("10.0.0.2");
    expect(entry.req.headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(entry.req.headers["user-agent"]).toBe("vistablox-test/1.0");
  });

  it("censors the passkey challenge relayed via header instead of a cookie", () => {
    const { logger, lines } = captureLogger();

    logger.info(
      {
        req: { headers: { "x-passkey-challenge": "challenge-token.signature" } },
        res: { headers: { "set-passkey-challenge": "challenge-token.signature" } },
      },
      "request completed",
    );

    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry.req.headers["x-passkey-challenge"]).toBe("[REDACTED]");
    expect(entry.res.headers["set-passkey-challenge"]).toBe("[REDACTED]");
    expect(lines[0]).not.toContain("challenge-token.signature");
  });
});

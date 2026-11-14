import { Writable } from "node:stream";
import { gzipSync } from "node:zlib";

import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { translateBodyParserError } from "../src/shared/http/body-parser-error.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { errorResponseSchema } from "../src/shared/http/error-schema.js";
import { requestContext } from "../src/shared/http/request-context.js";

const errorTypeBase = "https://api.vistablox.io/errors/";

// A value that must never reach a response body or a log line. The request
// bodies below carry it, and so do the synthetic errors, the way body-parser's
// own errors do (`body`, and a JSON.parse message that quotes the input).
const secret = "hunter2";

interface LogEntry {
  level: number;
  msg?: string;
  trace_id?: string;
  status?: number;
  code?: string;
  parser_error?: string;
  err?: { message?: string };
}

// Shaped like the errors body-parser and raw-body create with http-errors:
// `type`, `status`, `expose`, and the client's input in `message` and `body`.
function parserError(properties: Record<string, unknown>): Error {
  return Object.assign(new Error(`could not read ${secret}`), {
    body: `{"password":"${secret}"`,
    ...properties,
  });
}

function captureLogs() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return {
    logger: pino({ level: "trace" }, destination),
    lines,
    entries: (): LogEntry[] => lines.map((line) => JSON.parse(line) as LogEntry),
  };
}

function buildApp(options?: { listPublicFailure?: Error }) {
  const logs = captureLogs();
  const app = createApp({
    databaseProbe: { check: vi.fn().mockResolvedValue(undefined) },
    offeringRepository: {
      listPublic:
        options?.listPublicFailure === undefined
          ? vi.fn().mockResolvedValue([])
          : vi.fn().mockRejectedValue(options.listPublicFailure),
      getInvestorDetail: vi.fn().mockResolvedValue(null),
    },
    logger: logs.logger,
    corsOrigins: [],
  });
  return { app, logs };
}

// The body parser runs before routing, so a POST to any path reaches it; the
// route itself never matters for these cases.
function postJson(app: express.Express, body: string | Buffer) {
  return request(app)
    .post("/v1/offerings")
    .set("content-type", "application/json")
    .serialize((payload: unknown) => payload as string)
    .send(body);
}

function expectEnvelope(
  response: request.Response,
  expected: { status: number; code: string },
) {
  expect(response.status).toBe(expected.status);
  const body = errorResponseSchema.parse(response.body);
  expect(body).toMatchObject({
    type: `${errorTypeBase}${expected.code}`,
    code: expected.code,
    status: expected.status,
  });
  expect(body.title.length).toBeGreaterThan(0);
  expect(body.detail.length).toBeGreaterThan(0);
  expect(body.trace_id).toBe(response.headers["x-trace-id"]);
  expect(response.body).not.toHaveProperty("field_errors");
  return body;
}

function expectRejectedBodyLoggedAsWarning(
  logs: ReturnType<typeof captureLogs>,
  expected: { status: number; code: string; parserError: string },
  traceId: string,
) {
  const entries = logs.entries();
  const rejected = entries.filter((entry) => entry.msg === "request body rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({
    level: 40,
    trace_id: traceId,
    status: expected.status,
    code: expected.code,
    parser_error: expected.parserError,
  });
  // Nothing at error level: this is the client's mistake, not an outage.
  expect(entries.filter((entry) => entry.level >= 50)).toEqual([]);
  // And nothing the client sent is echoed into the logs.
  expect(logs.lines.join("")).not.toContain(secret);
}

describe("request body parser errors through createApp", () => {
  it.each([
    ["a truncated object", `{"password":"${secret}", `],
    ["a trailing comma", `{"password":"${secret}",}`],
    ["single-quoted keys", `{'password':'${secret}'}`],
    // Strict mode only accepts objects and arrays; JSON.parse's message for
    // this quotes the first characters of the input.
    ["a bare string", `"${secret} is my password"`],
    ["whitespace only", "   "],
  ])("answers %s with 400 request.invalid_json", async (_name, payload) => {
    const { app, logs } = buildApp();

    const response = await postJson(app, payload);

    const body = expectEnvelope(response, { status: 400, code: "request.invalid_json" });
    expect(response.text).not.toContain(secret);
    expectRejectedBodyLoggedAsWarning(
      logs,
      { status: 400, code: "request.invalid_json", parserError: "entity.parse.failed" },
      body.trace_id,
    );
  });

  it("answers a body over the 1 MB limit with 413 request.payload_too_large", async () => {
    const { app, logs } = buildApp();

    const response = await postJson(
      app,
      JSON.stringify({ password: secret, padding: "x".repeat(1_200_000) }),
    );

    const body = expectEnvelope(response, { status: 413, code: "request.payload_too_large" });
    expectRejectedBodyLoggedAsWarning(
      logs,
      { status: 413, code: "request.payload_too_large", parserError: "entity.too.large" },
      body.trace_id,
    );
  });

  it("measures the limit on the decompressed body", async () => {
    const { app } = buildApp();

    // Compresses to about a kilobyte, inflates past 1 MB.
    const response = await postJson(
      app,
      gzipSync(JSON.stringify({ padding: "x".repeat(1_200_000) })),
    ).set("content-encoding", "gzip");

    expectEnvelope(response, { status: 413, code: "request.payload_too_large" });
  });

  it.each([
    ["latin1", "application/json; charset=latin1"],
    // Passes the parser's utf-* prefix check and is rejected by the decoder.
    ["a nonexistent utf-* charset", "application/json; charset=utf-99"],
  ])("answers %s with 415 request.unsupported_charset", async (_name, contentType) => {
    const { app, logs } = buildApp();

    const response = await request(app)
      .post("/v1/offerings")
      .set("content-type", contentType)
      .serialize((payload: unknown) => payload as string)
      .send(`{"password":"${secret}"}`);

    const body = expectEnvelope(response, { status: 415, code: "request.unsupported_charset" });
    expectRejectedBodyLoggedAsWarning(
      logs,
      {
        status: 415,
        code: "request.unsupported_charset",
        parserError: "charset.unsupported",
      },
      body.trace_id,
    );
  });

  it("answers an unsupported Content-Encoding with 415 request.unsupported_encoding", async () => {
    const { app, logs } = buildApp();

    const response = await postJson(app, `{"password":"${secret}"}`).set(
      "content-encoding",
      "zstd",
    );

    const body = expectEnvelope(response, { status: 415, code: "request.unsupported_encoding" });
    expectRejectedBodyLoggedAsWarning(
      logs,
      {
        status: 415,
        code: "request.unsupported_encoding",
        parserError: "encoding.unsupported",
      },
      body.trace_id,
    );
  });

  it("answers a corrupt gzip body with 400 request.body_rejected", async () => {
    const { app, logs } = buildApp();

    const response = await postJson(app, Buffer.from(`not gzip data ${secret}`)).set(
      "content-encoding",
      "gzip",
    );

    const body = expectEnvelope(response, { status: 400, code: "request.body_rejected" });
    expectRejectedBodyLoggedAsWarning(
      logs,
      { status: 400, code: "request.body_rejected", parserError: "Z_DATA_ERROR" },
      body.trace_id,
    );
  });

  it("still parses a valid body, plain or gzipped, and hands it to routing", async () => {
    const { app, logs } = buildApp();
    const valid = JSON.stringify({ ok: true });

    const plain = await postJson(app, valid);
    const gzipped = await postJson(app, gzipSync(valid)).set("content-encoding", "gzip");

    // No POST route exists at this path, so a parsed body ends in the 404
    // handler, not in a parser rejection.
    for (const response of [plain, gzipped]) {
      expectEnvelope(response, { status: 404, code: "resource.not_found" });
    }
    expect(logs.entries().filter((entry) => entry.msg === "request body rejected")).toEqual([]);
  });

  it("does not turn a non-JSON content type into a parser error", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/v1/offerings")
      .set("content-type", "text/plain")
      .send("not json at all");

    // The parser skips content types it does not handle.
    expectEnvelope(response, { status: 404, code: "resource.not_found" });
  });

  it("keeps a genuinely unexpected failure a 500 logged at error level", async () => {
    const failure = new Error("connection to the database was lost");
    const { app, logs } = buildApp({ listPublicFailure: failure });

    const response = await request(app).get("/v1/offerings");

    const body = expectEnvelope(response, { status: 500, code: "internal.unexpected" });
    expect(body.detail).toBe("An unexpected error occurred.");
    const entries = logs.entries();
    const failed = entries.filter((entry) => entry.msg === "request failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      level: 50,
      trace_id: body.trace_id,
      err: { message: "connection to the database was lost" },
    });
    expect(entries.filter((entry) => entry.msg === "request body rejected")).toEqual([]);
  });
});

// The same handler, fed errors shaped like body-parser's. Covers the types a
// socket-level test cannot trigger reliably.
describe("errorHandler with body-parser shaped errors", () => {
  function appFailingWith(error: unknown) {
    const logs = captureLogs();
    const app = express();
    app.use(requestContext);
    app.use((_request, response, next) => {
      response.locals.logger = logs.logger;
      next();
    });
    app.get("/fail", (_request, _response, next) => next(error));
    app.use(errorHandler);
    return { app, logs };
  }

  it.each([
    ["entity.parse.failed", 400, "request.invalid_json"],
    ["entity.too.large", 413, "request.payload_too_large"],
    ["charset.unsupported", 415, "request.unsupported_charset"],
    ["encoding.unsupported", 415, "request.unsupported_encoding"],
    ["request.aborted", 400, "request.aborted"],
    ["request.size.invalid", 400, "request.size_mismatch"],
  ])("maps %s to %i %s", async (type, status, code) => {
    const { app, logs } = appFailingWith(
      parserError({ type, status, statusCode: status, expose: true }),
    );

    const response = await request(app).get("/fail");

    const body = expectEnvelope(response, { status, code });
    expect(response.text).not.toContain(secret);
    expectRejectedBodyLoggedAsWarning(logs, { status, code, parserError: type }, body.trace_id);
  });

  it("uses the error's own 4xx status for a client error it has no specific code for", async () => {
    const { app, logs } = appFailingWith(
      parserError({ code: "ERR_SOMETHING_ELSE", status: 422, statusCode: 422, expose: true }),
    );

    const response = await request(app).get("/fail");

    const body = expectEnvelope(response, { status: 422, code: "request.body_rejected" });
    expectRejectedBodyLoggedAsWarning(
      logs,
      { status: 422, code: "request.body_rejected", parserError: "ERR_SOMETHING_ELSE" },
      body.trace_id,
    );
  });

  it("logs a parser error name of unknown for a client error with neither type nor code", async () => {
    const { app, logs } = appFailingWith(parserError({ status: 400, statusCode: 400, expose: true }));

    const response = await request(app).get("/fail");

    const body = expectEnvelope(response, { status: 400, code: "request.body_rejected" });
    expectRejectedBodyLoggedAsWarning(
      logs,
      { status: 400, code: "request.body_rejected", parserError: "unknown" },
      body.trace_id,
    );
  });

  it.each([
    ["a plain Error", new Error(`boom ${secret}`)],
    ["a thrown string", `boom ${secret}`],
    ["a thrown number", 42],
    // http-errors marks 5xx as not exposable; these are the parser's own bugs.
    [
      "a parser failure on the server's side",
      parserError({ type: "stream.encoding.set", status: 500, statusCode: 500, expose: false }),
    ],
    // Only 4xx is a client error, whatever the error says about exposing it.
    ["a 500 status with expose", parserError({ status: 500, statusCode: 500, expose: true })],
    ["a 503 status with expose", parserError({ status: 503, statusCode: 503, expose: true })],
    ["a 399 status with expose", parserError({ status: 399, statusCode: 399, expose: true })],
    ["a string status with expose", parserError({ status: "400", statusCode: "400", expose: true })],
    // A status alone, without http-errors' expose flag, is not a client error.
    ["a 4xx status without expose", parserError({ status: 400, statusCode: 400 })],
    ["a 4xx status with expose false", parserError({ status: 404, expose: false })],
    // Inherited Object.prototype keys must not look like known types.
    ["a type named like an Object.prototype key", parserError({ type: "toString" })],
  ])("keeps %s a 500 internal.unexpected", async (_name, error) => {
    const { app, logs } = appFailingWith(error);

    const response = await request(app).get("/fail");

    const body = expectEnvelope(response, { status: 500, code: "internal.unexpected" });
    expect(response.text).not.toContain(secret);
    const entries = logs.entries();
    expect(entries.filter((entry) => entry.level === 50 && entry.msg === "request failed")).toHaveLength(1);
    expect(entries.filter((entry) => entry.msg === "request body rejected")).toEqual([]);
    expect(entries[0]?.trace_id).toBe(body.trace_id);
  });
});

describe("translateBodyParserError", () => {
  it.each([
    { type: "entity.parse.failed", status: 400, expose: true },
    { type: "entity.too.large", status: 413, expose: true },
    { type: "charset.unsupported", status: 415, expose: true },
    { type: "encoding.unsupported", status: 415, expose: true },
    { type: "request.aborted", status: 400, expose: true },
    { type: "request.size.invalid", status: 400, expose: true },
    { code: "Z_DATA_ERROR", status: 400, expose: true },
  ])("keeps the parser's error and its message out of the result for %o", (properties) => {
    const failure = parserError(properties);

    const rejection = translateBodyParserError(failure);

    expect(rejection).toBeDefined();
    expect(rejection?.error.cause).toBeUndefined();
    expect(rejection?.error.message).not.toContain(secret);
    expect(rejection?.error.title).not.toContain(secret);
    expect(rejection?.parserError).not.toContain(secret);
  });

  it("leaves errors that are not the parser's alone", () => {
    expect(translateBodyParserError(undefined)).toBeUndefined();
    expect(translateBodyParserError({ issues: [] })).toBeUndefined();
    expect(
      translateBodyParserError(
        Object.assign(new Error("x"), { type: "https://api.vistablox.io/errors/x", status: 404 }),
      ),
    ).toBeUndefined();
  });
});

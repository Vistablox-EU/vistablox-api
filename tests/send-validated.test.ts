import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type {
  IdempotencyStore,
  StoredIdempotentResponse,
} from "../src/infrastructure/idempotency/idempotency-store.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { createIdempotencyMiddleware } from "../src/shared/http/idempotency.js";
import { requestContext } from "../src/shared/http/request-context.js";
import { parseResponse, sendValidated } from "../src/shared/http/send-validated.js";
import { captureLogs } from "./support/capture-logs.js";

const responseSchema = z.object({ data: z.object({ id: z.string().min(1), amount_eur: z.string() }) });

// A value that sits in a malformed payload and must never reach a log line or
// a response: it stands for customer data a serialisation bug could carry.
const secret = "hunter2-customer-iban-DE89370400440532013000";

function appFor(payload: () => unknown, status?: number, store?: IdempotencyStore) {
  const logs = captureLogs();
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals.logger = logs.logger;
    next();
  });
  const handler: express.RequestHandler = async (_request, response) => {
    sendValidated(response, responseSchema, payload(), status);
  };
  if (store === undefined) {
    app.post("/things", handler);
  } else {
    app.post("/things", createIdempotencyMiddleware(store, "test.send_validated"), handler);
  }
  app.use(errorHandler);
  return { app, logs };
}

function memoryStore(): IdempotencyStore & { rows: Map<string, StoredIdempotentResponse> } {
  const rows = new Map<string, StoredIdempotentResponse>();
  return {
    rows,
    find: vi.fn(async (key: string, endpoint: string) => rows.get(`${key}:${endpoint}`) ?? null),
    save: vi.fn(async (input) => {
      const saved = {
        requestBodyHash: input.requestBodyHash,
        responseStatus: input.responseStatus,
        responseBody: input.responseBody,
      };
      rows.set(`${input.idempotencyKey}:${input.endpoint}`, saved);
      return saved;
    }),
  };
}

describe("sendValidated", () => {
  it("sends the parsed payload with status 200 by default and drops keys the schema does not name", async () => {
    const { app } = appFor(() => ({ data: { id: "thing_01", amount_eur: "10.00", internal_note: secret } }));

    const response = await request(app).post("/things").send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { id: "thing_01", amount_eur: "10.00" } });
  });

  it("sends the given status", async () => {
    const { app } = appFor(() => ({ data: { id: "thing_01", amount_eur: "10.00" } }), 201);

    const response = await request(app).post("/things").send({});

    expect(response.status).toBe(201);
  });

  it("turns a payload that fails its response schema into a 500 internal.response_invalid, not a client 422", async () => {
    const { app } = appFor(() => ({ data: { id: "", amount_eur: secret, extra: [secret] } }));

    const response = await request(app).post("/things").set("x-trace-id", "req_trace_03").send({});

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      code: "internal.response_invalid",
      status: 500,
      detail: "An unexpected error occurred.",
      trace_id: "req_trace_03",
    });
    expect(response.body).not.toHaveProperty("field_errors");
    expect(JSON.stringify(response.body)).not.toContain(secret);
  });

  it("logs the failure at error level with the trace_id and the failing paths, without the payload values", async () => {
    const { app, logs } = appFor(() => ({ data: { id: "", amount_eur: 42 } }));

    await request(app).post("/things").set("x-trace-id", "req_trace_04").send({});

    const entry = logs.entries().find((candidate) => candidate.msg === "request failed");
    expect(entry).toMatchObject({ level: 50, trace_id: "req_trace_04", code: "internal.response_invalid", status: 500 });
    const serialised = JSON.stringify(entry);
    expect(serialised).toContain("data.id");
    expect(serialised).toContain("data.amount_eur");
    expect(serialised).toContain("invalid_type");
  });

  it("never puts the offending values into a log line", async () => {
    const { app, logs } = appFor(() => ({ data: { id: "", amount_eur: secret } }));

    await request(app).post("/things").send({});

    expect(logs.lines.join("\n")).not.toContain(secret);
  });

  it("is not stored by the idempotency middleware, so a same-key retry reaches the handler", async () => {
    const store = memoryStore();
    let broken = true;
    const { app } = appFor(
      () => (broken ? { data: { id: "", amount_eur: "10.00" } } : { data: { id: "thing_01", amount_eur: "10.00" } }),
      201,
      store,
    );

    const first = await request(app).post("/things").set("Idempotency-Key", "key-1").send({ amount: 1 });
    broken = false;
    const retry = await request(app).post("/things").set("Idempotency-Key", "key-1").send({ amount: 1 });

    expect(first.status).toBe(500);
    expect(store.rows.size).toBe(1);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ data: { id: "thing_01", amount_eur: "10.00" } });
  });
});

describe("parseResponse", () => {
  it("returns the parsed payload", () => {
    expect(parseResponse(responseSchema, { data: { id: "thing_01", amount_eur: "1.00", extra: 1 } })).toEqual({
      data: { id: "thing_01", amount_eur: "1.00" },
    });
  });

  it("throws a 500 internal.response_invalid for a payload that does not match", () => {
    expect(() => parseResponse(responseSchema, { data: { id: "", amount_eur: secret } })).toThrow(
      expect.objectContaining({ code: "internal.response_invalid", status: 500 }),
    );
  });
});

describe("routers answer through sendValidated", () => {
  // A raw `response.json(schema.parse(result))` turns a server-side
  // serialisation bug into a 422 that looks like the client's mistake (#72).
  it("no router parses a response schema outside sendValidated or parseResponse", () => {
    const offenders: string[] = [];
    for (const file of routerFiles(join(import.meta.dirname, "..", "src"))) {
      const source = readFileSync(file, "utf8");
      // `response.json(xSchema.parse(...))`, or a response schema parsed into a
      // variable that is sent afterwards.
      if (/\.json\(\s*[A-Za-z0-9_$.]+\.parse\(/.test(source) || /\w*ResponseSchema\.parse\(/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

function routerFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "generated") continue;
      found.push(...routerFiles(path));
    } else if (entry.endsWith(".router.ts")) {
      found.push(path);
    }
  }
  return found;
}

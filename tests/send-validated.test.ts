import { readFileSync } from "node:fs";
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
import { sendValidated } from "../src/shared/http/send-validated.js";
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

// The routers the mobile app's audit named (#72). Other routers still serialise
// with a bare `schema.parse` and answer a server-side schema bug as a 422; moving
// them over is a mechanical follow-up (add them here as they are converted).
const convertedRouters = [
  "src/modules/offering/api/offering.router.ts",
  "src/modules/investor-activity/api/investor-activity.router.ts",
  "src/modules/profile/api/profile.router.ts",
  "src/modules/identity/api/kyc.router.ts",
  "src/modules/wallet/api/wallet.router.ts",
];

describe("converted routers answer through sendValidated", () => {
  // A raw `response.json(schema.parse(result))` turns a server-side
  // serialisation bug into a 422 that looks like the client's mistake (#72).
  it.each(convertedRouters)("%s serialises no response with a bare schema.parse", (path) => {
    const source = readFileSync(join(import.meta.dirname, "..", path), "utf8");
    // `response.json(xSchema.parse(...))`, or a response schema parsed into a
    // variable that is sent afterwards.
    expect(source).not.toMatch(/\.json\(\s*[A-Za-z0-9_$.]+\.parse\(/);
    expect(source).not.toMatch(/\w*ResponseSchema\.parse\(/);
    expect(source).toContain("sendValidated(");
  });
});

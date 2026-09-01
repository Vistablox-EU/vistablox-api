import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type {
  IdempotencyStore,
  StoredIdempotentResponse,
} from "../src/infrastructure/idempotency/idempotency-store.js";
import { createIdempotencyMiddleware } from "../src/shared/http/idempotency.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

function memoryStore(): IdempotencyStore & {
  rows: Map<string, StoredIdempotentResponse>;
} {
  const rows = new Map<string, StoredIdempotentResponse>();
  return {
    rows,
    find: vi.fn(async (idempotencyKey: string, endpoint: string) => {
      return rows.get(`${idempotencyKey}:${endpoint}`) ?? null;
    }),
    save: vi.fn(async (input) => {
      const key = `${input.idempotencyKey}:${input.endpoint}`;
      const existing = rows.get(key);
      if (existing !== undefined) return existing;
      const saved: StoredIdempotentResponse = {
        requestBodyHash: input.requestBodyHash,
        responseStatus: input.responseStatus,
        responseBody: input.responseBody,
      };
      rows.set(key, saved);
      return saved;
    }),
  };
}

function appFor(store: IdempotencyStore, handler: (body: unknown) => void) {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.post(
    "/orders",
    createIdempotencyMiddleware(store, "test.create_order"),
    async (request, response) => {
      handler(request.body);
      response.status(201).json({ order_id: "order_01" });
    },
  );
  app.use(errorHandler);
  return app;
}

describe("idempotency middleware", () => {
  it("requires the Idempotency-Key header", async () => {
    const response = await request(appFor(memoryStore(), vi.fn())).post("/orders").send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "idempotency.key_required", status: 400 });
  });

  it("runs the handler once and caches its response on first use", async () => {
    const handler = vi.fn();
    const app = appFor(memoryStore(), handler);

    const response = await request(app)
      .post("/orders")
      .set("Idempotency-Key", "key-1")
      .send({ amount: 100 });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ order_id: "order_01" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("replays the cached response for a matching key and body without re-running the handler", async () => {
    const handler = vi.fn();
    const store = memoryStore();
    const app = appFor(store, handler);

    await request(app).post("/orders").set("Idempotency-Key", "key-1").send({ amount: 100 });
    const replay = await request(app)
      .post("/orders")
      .set("Idempotency-Key", "key-1")
      .send({ amount: 100 });

    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ order_id: "order_01" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects the same key reused with a different body as a 409 conflict", async () => {
    const handler = vi.fn();
    const app = appFor(memoryStore(), handler);

    await request(app).post("/orders").set("Idempotency-Key", "key-1").send({ amount: 100 });
    const conflict = await request(app)
      .post("/orders")
      .set("Idempotency-Key", "key-1")
      .send({ amount: 200 });

    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "idempotency.body_mismatch", status: 409 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fails closed with 503 when the store cannot be reached before the handler runs", async () => {
    const store = memoryStore();
    store.find = vi.fn().mockRejectedValue(new Error("connection reset"));
    const handler = vi.fn();

    const response = await request(appFor(store, handler))
      .post("/orders")
      .set("Idempotency-Key", "key-1")
      .send({ amount: 100 });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "idempotency.store_unavailable", status: 503 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("still returns the handler's response when saving it afterward fails", async () => {
    const store = memoryStore();
    store.save = vi.fn().mockRejectedValue(new Error("connection reset"));
    const handler = vi.fn();

    const response = await request(appFor(store, handler))
      .post("/orders")
      .set("Idempotency-Key", "key-1")
      .send({ amount: 100 });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ order_id: "order_01" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

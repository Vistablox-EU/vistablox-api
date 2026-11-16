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

// The handler may return a status to answer with instead of the default 201.
function appFor(store: IdempotencyStore, handler: (body: unknown) => number | void) {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.post(
    "/orders",
    createIdempotencyMiddleware(store, "test.create_order"),
    async (request, response) => {
      const status = handler(request.body) ?? 201;
      if (status >= 400) {
        response.status(status).json({ code: `test.failed_${status}` });
        return;
      }
      response.status(status).json({ order_id: "order_01" });
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

  it("hashes and replays a bodyless request (actions like reconfirmation post no body)", async () => {
    const handler = vi.fn();
    const app = appFor(memoryStore(), handler);

    const first = await request(app).post("/orders").set("Idempotency-Key", "key-bodyless");
    const replay = await request(app).post("/orders").set("Idempotency-Key", "key-bodyless");

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ order_id: "order_01" });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ order_id: "order_01" });
    expect(handler).toHaveBeenCalledTimes(1);
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

  it("does not store a 5xx, so a same-key retry re-runs the handler (#122)", async () => {
    const handler = vi.fn().mockReturnValueOnce(502).mockReturnValueOnce(undefined);
    const store = memoryStore();
    const app = appFor(store, handler);

    const failed = await request(app)
      .post("/orders")
      .set("Idempotency-Key", "key-5xx")
      .send({ amount: 100 });
    const retry = await request(app)
      .post("/orders")
      .set("Idempotency-Key", "key-5xx")
      .send({ amount: 100 });
    const replay = await request(app)
      .post("/orders")
      .set("Idempotency-Key", "key-5xx")
      .send({ amount: 100 });

    expect(failed.status).toBe(502);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ order_id: "order_01" });
    expect(replay.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("still stores and replays a 4xx for the same key", async () => {
    const handler = vi.fn().mockReturnValue(422);
    const app = appFor(memoryStore(), handler);

    await request(app).post("/orders").set("Idempotency-Key", "key-4xx").send({ amount: 100 });
    const replay = await request(app)
      .post("/orders")
      .set("Idempotency-Key", "key-4xx")
      .send({ amount: 100 });

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ code: "test.failed_422" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

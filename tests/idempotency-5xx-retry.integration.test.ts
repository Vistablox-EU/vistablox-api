import { randomUUID } from "node:crypto";

import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaIdempotencyStore } from "../src/infrastructure/idempotency/prisma-idempotency-store.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { createIdempotencyMiddleware } from "../src/shared/http/idempotency.js";
import { requestContext } from "../src/shared/http/request-context.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// #122: a transient server failure (for example a Coinbase 5xx surfacing as a
// 502) used to be stored in audit.idempotency_keys and replayed for the whole
// retention window, so the client's same-key retry could never run again.
describe.skipIf(databaseUrl === undefined)("idempotency 5xx retry PostgreSQL integration", () => {
  const database = createPrismaClient(databaseUrl ?? "");
  const endpoint = `test.idempotency_5xx.${randomUUID()}`;

  afterAll(async () => {
    await database.idempotencyKey.deleteMany({ where: { endpoint } });
    await database.$disconnect();
  });

  function appWith(handler: () => void) {
    const app = express();
    app.use(requestContext);
    app.use(express.json());
    app.post(
      "/orders",
      createIdempotencyMiddleware(new PrismaIdempotencyStore(database), endpoint),
      (_request, response) => {
        handler();
        response.status(201).json({ order_id: "order_01" });
      },
    );
    app.use(errorHandler);
    return app;
  }

  async function storedRow(idempotencyKey: string) {
    return database.idempotencyKey.findUnique({
      where: { idempotencyKey_endpoint: { idempotencyKey, endpoint } },
    });
  }

  it("an idempotent retry after a transient 5xx re-executes the handler instead of replaying the error", async () => {
    const key = randomUUID();
    const handler = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new AppError({
          code: "test.upstream_unavailable",
          title: "Upstream unavailable",
          status: 502,
          detail: "The payment provider did not answer.",
        });
      })
      .mockImplementation(() => undefined);
    const app = appWith(handler);

    const failed = await request(app).post("/orders").set("Idempotency-Key", key).send({ amount: 100 });
    expect(failed.status).toBe(502);
    expect(await storedRow(key)).toBeNull();

    const retry = await request(app).post("/orders").set("Idempotency-Key", key).send({ amount: 100 });
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ order_id: "order_01" });
    expect(await storedRow(key)).toMatchObject({ responseStatus: 201 });

    const replay = await request(app).post("/orders").set("Idempotency-Key", key).send({ amount: 100 });
    expect(replay.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(2);

    const mismatch = await request(app).post("/orders").set("Idempotency-Key", key).send({ amount: 200 });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({ code: "idempotency.body_mismatch" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("still stores a 4xx and replays it for the same key", async () => {
    const key = randomUUID();
    const handler = vi.fn(() => {
      throw new AppError({
        code: "test.rejected",
        title: "Rejected",
        status: 409,
        detail: "The request was refused.",
      });
    });
    const app = appWith(handler);

    const first = await request(app).post("/orders").set("Idempotency-Key", key).send({ amount: 100 });
    const replay = await request(app).post("/orders").set("Idempotency-Key", key).send({ amount: 100 });

    expect(first.status).toBe(409);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ code: "test.rejected" });
    expect(await storedRow(key)).toMatchObject({ responseStatus: 409 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

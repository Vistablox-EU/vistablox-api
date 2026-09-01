import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { RateLimitStore } from "../src/infrastructure/rate-limit/rate-limit-store.js";
import { createRateLimiter, type RateLimitTier } from "../src/shared/http/rate-limit.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const tier: RateLimitTier = { name: "test", limit: 2, windowSeconds: 60 };

function counterStore(): RateLimitStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    increment: vi.fn(async (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    }),
  };
}

function appFor(store: RateLimitStore, authenticated?: RequestHandler) {
  const app = express();
  app.use(requestContext);
  if (authenticated !== undefined) app.use(authenticated);
  app.use(createRateLimiter(store, tier));
  app.get("/probe", (_request, response) => response.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

function asAccount(accountId: string): RequestHandler {
  return (_request, response, next) => {
    response.locals.authContext = {
      accountId,
      providerSessionId: "session_01",
      population: "customer",
    };
    next();
  };
}

describe("rate limit middleware", () => {
  it("allows requests within the tier limit", async () => {
    const app = appFor(counterStore());

    const first = await request(app).get("/probe");
    const second = await request(app).get("/probe");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("returns the stable 429 envelope with Retry-After once the limit is exceeded", async () => {
    const app = appFor(counterStore());

    await request(app).get("/probe");
    await request(app).get("/probe");
    const third = await request(app).get("/probe");

    expect(third.status).toBe(429);
    expect(third.headers["retry-after"]).toBe("60");
    expect(third.body).toMatchObject({
      code: "rate_limit.exceeded",
      status: 429,
    });
    expect(third.body.trace_id).toMatch(/^req_/);
  });

  it("keys unauthenticated callers by IP, isolating them from each other's budget", async () => {
    const store = counterStore();
    const app = appFor(store);

    await request(app).get("/probe");

    const keys = [...store.counts.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^rate_limit_hint:test:ip:/);
  });

  it("keys authenticated callers by account_id instead of IP", async () => {
    const store = counterStore();
    const appA = appFor(store, asAccount("acct_a"));
    const appB = appFor(store, asAccount("acct_b"));

    await request(appA).get("/probe");
    await request(appA).get("/probe");
    const thirdForA = await request(appA).get("/probe");
    const firstForB = await request(appB).get("/probe");

    expect(thirdForA.status).toBe(429);
    expect(firstForB.status).toBe(200);
    expect([...store.counts.keys()].sort()).toEqual([
      "rate_limit_hint:test:account:acct_a",
      "rate_limit_hint:test:account:acct_b",
    ]);
  });

  it("fails open when the rate limit store is unavailable", async () => {
    const store: RateLimitStore = {
      increment: vi.fn().mockRejectedValue(new Error("connection reset")),
    };
    const app = appFor(store);

    const response = await request(app).get("/probe");

    expect(response.status).toBe(200);
  });
});

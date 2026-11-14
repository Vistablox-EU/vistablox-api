import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";

// IP rate limits (rateLimitSubject) key unauthenticated traffic on req.ip.
// Behind a reverse proxy that is the proxy's own address unless Express is told
// to trust it, so every caller shares one bucket -- and the tightened tier
// (10 requests a minute, applied to Better Auth's endpoints) would throttle all
// users together. These tests pin what trustProxy changes, and that the
// default still ignores X-Forwarded-For, which any direct caller can set.

function buildApp(trustProxy?: number | string[]) {
  const increment = vi.fn().mockResolvedValue(1);
  const app = createApp({
    databaseProbe: { check: vi.fn() },
    offeringRepository: {
      listPublic: vi.fn().mockResolvedValue([]),
      getInvestorDetail: vi.fn().mockResolvedValue(null),
    },
    logger: pino({ level: "silent" }),
    corsOrigins: [],
    rateLimitStore: { increment },
    ...(trustProxy === undefined ? {} : { trustProxy }),
  });
  const subjectOf = (call: number): string => {
    const key = String(increment.mock.calls[call]?.[0]);
    return key.slice(key.indexOf("ip:"));
  };
  return { app, subjectOf };
}

describe("trust proxy", () => {
  it("keys the IP limiter on the connecting address and ignores X-Forwarded-For by default", async () => {
    const { app, subjectOf } = buildApp();

    await request(app).get("/v1/offerings");
    await request(app).get("/v1/offerings").set("X-Forwarded-For", "203.0.113.7");
    await request(app).get("/v1/offerings").set("X-Forwarded-For", "198.51.100.9");

    const peer = subjectOf(0);
    expect(peer).toMatch(/^ip:/);
    expect(subjectOf(1)).toBe(peer);
    expect(subjectOf(2)).toBe(peer);
  });

  it("with a hop count, separates callers by the address the proxy appended and ignores earlier, client-supplied entries", async () => {
    const { app, subjectOf } = buildApp(1);

    await request(app).get("/v1/offerings").set("X-Forwarded-For", "203.0.113.7");
    await request(app).get("/v1/offerings").set("X-Forwarded-For", "198.51.100.9");
    await request(app).get("/v1/offerings").set("X-Forwarded-For", "198.51.100.9, 203.0.113.7");

    expect(subjectOf(0)).toBe("ip:203.0.113.7");
    expect(subjectOf(1)).toBe("ip:198.51.100.9");
    // The leftmost entry is whatever the client claimed; only the entry the
    // trusted proxy added counts.
    expect(subjectOf(2)).toBe("ip:203.0.113.7");
  });

  it("with proxy subnets, honours X-Forwarded-For only when the connection comes from one of them", async () => {
    const trusted = buildApp(["loopback"]);
    await request(trusted.app).get("/v1/offerings").set("X-Forwarded-For", "203.0.113.7");
    expect(trusted.subjectOf(0)).toBe("ip:203.0.113.7");

    const untrusted = buildApp(["192.0.2.0/24"]);
    await request(untrusted.app).get("/v1/offerings");
    await request(untrusted.app).get("/v1/offerings").set("X-Forwarded-For", "203.0.113.7");
    // A caller reaching the API directly (bypassing the proxy) cannot pick its
    // own rate-limit bucket.
    expect(untrusted.subjectOf(1)).toBe(untrusted.subjectOf(0));
  });

  it("with a hop count above the real number of proxies, a non-IP entry the caller wrote cannot become its bucket key", async () => {
    const { app, subjectOf } = buildApp(2);

    await request(app).get("/v1/offerings");
    await request(app).get("/v1/offerings").set("X-Forwarded-For", "attacker-chosen-bucket-1, 203.0.113.9");

    // Express hands the caller's own entry back as req.ip; it is not an
    // address, so the connecting address is used instead.
    expect(subjectOf(1)).toBe(subjectOf(0));
  });

  it("a hop count of 0 trusts no proxy", async () => {
    const { app, subjectOf } = buildApp(0);

    await request(app).get("/v1/offerings");
    await request(app).get("/v1/offerings").set("X-Forwarded-For", "203.0.113.7");

    expect(subjectOf(1)).toBe(subjectOf(0));
  });
});

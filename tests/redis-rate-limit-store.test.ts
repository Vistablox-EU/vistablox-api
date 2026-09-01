import { describe, expect, it, vi } from "vitest";

import { RedisRateLimitStore } from "../src/infrastructure/rate-limit/redis-rate-limit-store.js";

function redisClient(startingCount = 1) {
  let count = startingCount - 1;
  return {
    isReady: true,
    incr: vi.fn().mockImplementation(async () => {
      count += 1;
      return count;
    }),
    expire: vi.fn().mockResolvedValue(1),
  };
}

describe("Redis rate limit store", () => {
  it("starts a fixed window TTL only on the first increment", async () => {
    const redis = redisClient();
    const store = new RedisRateLimitStore(redis);

    await expect(store.increment("rate_limit_hint:baseline:ip:1.2.3.4", 60)).resolves.toBe(1);
    expect(redis.expire).toHaveBeenCalledWith("rate_limit_hint:baseline:ip:1.2.3.4", 60);

    await expect(store.increment("rate_limit_hint:baseline:ip:1.2.3.4", 60)).resolves.toBe(2);
    expect(redis.expire).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Redis is not ready", async () => {
    const redis = { ...redisClient(), isReady: false };

    await expect(
      new RedisRateLimitStore(redis).increment("rate_limit_hint:baseline:ip:1.2.3.4", 60),
    ).rejects.toThrow("Rate limit store unavailable");
    expect(redis.incr).not.toHaveBeenCalled();
  });
});

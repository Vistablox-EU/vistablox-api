import { describe, expect, it, vi } from "vitest";

import { RedisProtectedProfileCache } from "../src/infrastructure/cache/redis-protected-profile-cache.js";

function redisClient(initialValue: string | null = null) {
  return {
    isReady: true,
    get: vi.fn().mockResolvedValue(initialValue),
    setEx: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
  };
}

describe("protected profile cache", () => {
  it("stores only the allow-listed names with a hard 24-hour TTL", async () => {
    const redis = redisClient();
    const cache = new RedisProtectedProfileCache(redis);

    await cache.set("acct_01", {
      givenName: "Carmen",
      familyName: "Silva",
      fullDisplayName: "Carmen Silva",
      syncedAt: new Date("2026-09-01T10:00:00.000Z"),
    });

    expect(redis.setEx).toHaveBeenCalledWith(
      "kyc_display:acct_01",
      86_400,
      JSON.stringify({
        given_name: "Carmen",
        family_name: "Silva",
        full_display_name: "Carmen Silva",
        didit_profile_last_synced_at: "2026-09-01T10:00:00.000Z",
      }),
    );
  });

  it("deletes cache entries containing malformed or non-allow-listed data", async () => {
    const redis = redisClient(
      JSON.stringify({
        given_name: "Carmen",
        family_name: "Silva",
        full_display_name: "Carmen Silva",
        didit_profile_last_synced_at: "2026-09-01T10:00:00.000Z",
        document_number: "must-not-be-cached",
      }),
    );
    const cache = new RedisProtectedProfileCache(redis);

    await expect(cache.get("acct_01")).resolves.toBeNull();
    expect(redis.del).toHaveBeenCalledWith("kyc_display:acct_01");
  });

  it("fails closed when Redis is not ready", async () => {
    const redis = { ...redisClient(), isReady: false };

    await expect(
      new RedisProtectedProfileCache(redis).get("acct_01"),
    ).rejects.toThrow("Protected profile cache unavailable");
    expect(redis.get).not.toHaveBeenCalled();
  });
});

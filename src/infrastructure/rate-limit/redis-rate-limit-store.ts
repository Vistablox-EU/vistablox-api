import type { RateLimitStore } from "./rate-limit-store.js";

interface RedisCounterClient {
  readonly isReady: boolean;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export class RedisRateLimitStore implements RateLimitStore {
  public constructor(private readonly client: RedisCounterClient) {}

  public async increment(key: string, windowSeconds: number): Promise<number> {
    if (!this.client.isReady) throw new Error("Rate limit store unavailable");
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, windowSeconds);
    }
    return count;
  }
}

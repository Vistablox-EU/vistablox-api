export interface RateLimitStore {
  /**
   * Increments the counter for `key` and returns the new count. Starts a
   * fresh `windowSeconds` TTL the first time a key is seen; ttl is left
   * untouched on subsequent increments so the window is fixed, not rolling.
   */
  increment(key: string, windowSeconds: number): Promise<number>;
}

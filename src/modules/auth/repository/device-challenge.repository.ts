export interface DeviceChallengeRepository {
  issue(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * Atomically consumes a challenge: returns its `deviceId` (possibly
   * `undefined`) on success, or `null` if the challenge doesn't exist,
   * doesn't match `purpose`, is already consumed, or has expired -- a
   * single atomic UPDATE, so those cases are indistinguishable here (no
   * separate read to avoid a TOCTOU gap between "check" and "consume").
   * The contract's DEVICE_CHALLENGE_REPLAYED and DEVICE_CHALLENGE_EXPIRED
   * share the same client behaviour (fetch a new challenge, retry once) --
   * the caller reports DEVICE_CHALLENGE_EXPIRED uniformly for a `null`
   * result.
   */
  consume(input: { challenge: string; purpose: string; now: Date }): Promise<{
    deviceId: string | undefined;
  } | null>;
  pruneExpired(now: Date): Promise<number>;
}

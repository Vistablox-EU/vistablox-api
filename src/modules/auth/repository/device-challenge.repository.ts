export interface DeviceChallengeRepository {
  issue(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * Atomically consumes a challenge: succeeds only when `challenge`,
   * `purpose`, `dpopJkt`, and `deviceId` all match what was recorded at
   * issuance (device_id null-safely, since enrol-device issues with none) --
   * a single atomic UPDATE, so a wrong purpose, wrong DPoP key, wrong
   * device_id, already-consumed, expired, and nonexistent are all
   * indistinguishable to the caller (no separate read to avoid a TOCTOU
   * gap between "check" and "consume"). Without the dpopJkt/deviceId match,
   * a challenge issued for one requester could be redeemed by a
   * completely different one presenting an otherwise-valid JWS. The
   * contract's DEVICE_CHALLENGE_REPLAYED and DEVICE_CHALLENGE_EXPIRED share
   * the same client behaviour (fetch a new challenge, retry once) -- the
   * caller reports DEVICE_CHALLENGE_EXPIRED uniformly for a `false` result.
   */
  consume(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
    now: Date;
  }): Promise<boolean>;
  pruneExpired(now: Date): Promise<number>;
}

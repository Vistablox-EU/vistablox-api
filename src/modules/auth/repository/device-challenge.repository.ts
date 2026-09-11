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
   * a single atomic UPDATE, so no check-then-consume gap. Without the
   * dpopJkt/deviceId match, a challenge issued for one requester could be
   * redeemed by a completely different one presenting an otherwise-valid
   * JWS. `now` is recorded as the consumption time. A `false` result covers
   * wrong purpose, wrong DPoP key, wrong device_id, already consumed,
   * expired and unknown alike; the caller then asks wasConsumedSince to tell
   * DEVICE_CHALLENGE_REPLAYED apart from DEVICE_CHALLENGE_EXPIRED.
   */
  consume(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
    now: Date;
  }): Promise<boolean>;
  /**
   * Whether this exact challenge (same purpose, DPoP key and device_id) was
   * consumed at or after `since`. Asked only after consume() fails (see
   * domain/device-challenge-replay.ts). A challenge issued to a different
   * DPoP key or device never matches, so this reveals nothing about anyone
   * else's challenges.
   */
  wasConsumedSince(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
    since: Date;
  }): Promise<boolean>;
  /**
   * Deletes challenges whose expiry passed more than the replay window ago.
   * They're kept that long so a replay of a recently used challenge still
   * answers REPLAYED rather than looking unknown.
   */
  pruneExpired(now: Date): Promise<number>;
}

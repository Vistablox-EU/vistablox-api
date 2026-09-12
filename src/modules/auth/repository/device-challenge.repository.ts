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
   * JWS.
   *
   * `now` (the API clock that also set expires_at at issuance) decides
   * expiry. The consumption time is recorded from the database's clock, which
   * the replay window and the enrolment insert deadline are measured on
   * (domain/device-challenge-replay.ts).
   *
   * A `false` result covers wrong purpose, wrong DPoP key, wrong device_id,
   * already consumed, expired and unknown alike; the caller then asks
   * wasConsumedWithinReplayWindow to tell DEVICE_CHALLENGE_REPLAYED apart from
   * DEVICE_CHALLENGE_EXPIRED.
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
   * consumed less than CHALLENGE_REPLAY_WINDOW_MS ago, by the database's
   * clock. Asked only after consume() fails. A challenge issued to a
   * different DPoP key or device never matches, so this reveals nothing
   * about anyone else's challenges.
   */
  wasConsumedWithinReplayWindow(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
  }): Promise<boolean>;
  /**
   * Deletes challenges whose expiry passed more than the replay window ago.
   * They're kept that long so a replay of a recently used challenge still
   * answers REPLAYED rather than looking unknown.
   */
  pruneExpired(now: Date): Promise<number>;
}

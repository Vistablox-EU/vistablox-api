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
   * Expiry is checked, and the consumption time recorded, on the database's
   * clock, which the replay window and the enrolment insert deadline are
   * measured on too (domain/device-challenge-replay.ts).
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
   * Deletes challenges whose expiry passed more than the replay window ago,
   * by the database's clock (the worker's clock plays no part). They're kept
   * that long so a replay of a recently used challenge still answers
   * REPLAYED rather than looking unknown. The challenge row of an enrolment
   * that is registering its device is locked until that insert commits or
   * aborts (PrismaDeviceRepository.create), so pruning waits for it.
   */
  pruneExpired(): Promise<number>;
}

export interface DpopReplayRepository {
  /** Records a (jkt, jti) pair. Returns false if it was already recorded (replay). */
  recordProof(jkt: string, jti: string, expiresAt: Date): Promise<boolean>;
  /** Deletes rows past their expiry. Returns the number removed. */
  pruneExpired(now: Date): Promise<number>;
}

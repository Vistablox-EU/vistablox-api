// Single-use device challenges (contract 3.2/3.6): when an already-used
// challenge answers DEVICE_CHALLENGE_REPLAYED instead of
// DEVICE_CHALLENGE_EXPIRED, and the enrolment deadline that makes that safe.
//
// Invariant (E2): the server answers DEVICE_CHALLENGE_EXPIRED only when no
// enrolment that consumed this challenge can still register a device. The
// mobile app drops its pending biometric key only on EXPIRED.
//
// Why it holds:
// - An enrolment never inserts its device row later than
//   ENROLMENT_INSERT_DEADLINE_MS after it consumed its challenge; past that
//   point it aborts and registers nothing.
// - A replay is told EXPIRED for a consumed challenge only if the challenge
//   was consumed more than CHALLENGE_REPLAY_WINDOW_MS before the replay
//   started. The replay's start is taken before its own active-device check.
// - So any device row the consuming enrolment inserted was committed before
//   that check ran, and the replay gets 409 DEVICE_ALREADY_ENROLLED, not
//   EXPIRED.
// - It converges: once the window has passed and nothing was registered, a
//   replay gets EXPIRED.
// The 60 s between the two limits covers the insert itself and clock skew
// between API instances.
//
// A challenge that was never consumed (unknown, or its TTL passed unused)
// is always EXPIRED: registration needs a consumed challenge.
export const CHALLENGE_REPLAY_WINDOW_MS = 120_000;
export const ENROLMENT_INSERT_DEADLINE_MS = 60_000;

/** Challenges consumed at or after this time answer REPLAYED to a request that started at `startedAt`. */
export function replayWindowStart(startedAt: Date): Date {
  return new Date(startedAt.getTime() - CHALLENGE_REPLAY_WINDOW_MS);
}

/** True once an enrolment may no longer insert its device row. */
export function isPastEnrolmentInsertDeadline(consumedAt: Date, now: Date): boolean {
  return now.getTime() - consumedAt.getTime() >= ENROLMENT_INSERT_DEADLINE_MS;
}

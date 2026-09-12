// Single-use device challenges (contract 3.2/3.6): when an already-used
// challenge answers DEVICE_CHALLENGE_REPLAYED instead of
// DEVICE_CHALLENGE_EXPIRED, and the enrolment deadline that makes that safe.
//
// Invariant (E2): the server answers DEVICE_CHALLENGE_EXPIRED only when no
// enrolment that consumed this challenge can still register a device. The
// mobile app drops its pending biometric key only on EXPIRED.
//
// Every time below is the database's clock, never an API instance's, so
// clock skew between instances and a stalled request can't break it:
// - consume() records consumed_at as the database's now().
// - A device row is inserted only inside a short transaction that first
//   checks, against the database clock, that its challenge was consumed
//   less than ENROLMENT_INSERT_DEADLINE_MS ago; past that it registers
//   nothing. Postgres statement, lock and idle-in-transaction timeouts
//   (a few seconds each, set on that transaction) bound how long it can
//   stay open after the check, so any row it inserts is committed well
//   inside CHALLENGE_REPLAY_WINDOW_MS of the consumption.
// - A replay answers REPLAYED while the challenge was consumed less than
//   CHALLENGE_REPLAY_WINDOW_MS ago (database clock). Past that, the
//   consuming enrolment has either committed its device row or registered
//   nothing. The replay then looks for a device with a new query, which sees
//   every committed row: 409 DEVICE_ALREADY_ENROLLED if there is one,
//   EXPIRED only if there isn't.
// - It converges: once the window has passed and nothing was registered, a
//   replay gets EXPIRED.
//
// A challenge that was never consumed (unknown, or its TTL passed unused)
// is EXPIRED unless a device is found the same way: registration needs a
// consumed challenge.
//
// Expired challenges are kept for CHALLENGE_REPLAY_WINDOW_MS after their
// expiry before pruning, so a replay of a recently used one still answers
// REPLAYED rather than looking unknown.
export const CHALLENGE_REPLAY_WINDOW_MS = 120_000;
export const ENROLMENT_INSERT_DEADLINE_MS = 60_000;

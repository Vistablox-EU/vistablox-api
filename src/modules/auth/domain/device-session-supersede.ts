// A successful device ceremony (E2 or L2) leaves the phone exactly one live
// session: of the user's live device_biometric sessions bound to the same
// DPoP key -- the same device -- only the newest is kept. Sessions bound to
// another key (another device), unbound ones (web), other authentication
// levels and other users' sessions are never touched.

/** The DPoP-key match POST /v1/auth/sessions/devices/:jkt/revoke also uses. */
export function isBoundToDpopKey(session: { dpopJkt?: unknown }, dpopJkt: string): boolean {
  return session.dpopJkt === dpopJkt;
}

interface SupersedeCandidate {
  id: string;
  token: string;
  dpopJkt?: unknown;
  authenticationLevel?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
}

/**
 * From one user's sessions, the ones a device ceremony on `dpopJkt`
 * revokes: every live device_biometric session bound to that key except the
 * newest.
 *
 * "Newest" is the greatest (createdAt, id): a total order, so every ceremony
 * picks the same survivor from whatever it sees.
 * - The newest is never revoked by anyone, so after any set of overlapping
 *   ceremonies from one phone, at least one session survives.
 * - Every other session is revoked either by the newest one's ceremony, or by
 *   its own ceremony, which runs after its own insert and so already sees any
 *   newer session the newest one's ceremony couldn't see yet. Once they've all
 *   finished, exactly one survives.
 *
 * So a ceremony can revoke the session it just created, when a newer one
 * already exists.
 */
export function sessionsToSupersede<T extends SupersedeCandidate>(
  sessions: readonly T[],
  dpopJkt: string,
  now: Date,
): T[] {
  const candidates = sessions.filter(
    (session) =>
      session.authenticationLevel === "device_biometric" &&
      isBoundToDpopKey(session, dpopJkt) &&
      !hasExpired(session.expiresAt, now),
  );
  if (candidates.length <= 1) return [];
  const newest = candidates.reduce((kept, session) => (isNewer(session, kept) ? session : kept));
  return candidates.filter((session) => session !== newest);
}

/** Whether `a` comes after `b`: later createdAt, or the same createdAt and a greater id. */
export function isNewer(a: SupersedeCandidate, b: SupersedeCandidate): boolean {
  const aTime = timeOf(a.createdAt);
  const bTime = timeOf(b.createdAt);
  if (aTime !== bTime) return aTime > bTime;
  return a.id > b.id;
}

function timeOf(value: unknown): number {
  const time =
    value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function hasExpired(expiresAt: unknown, now: Date): boolean {
  const time = timeOf(expiresAt);
  return Number.isFinite(time) && time <= now.getTime();
}

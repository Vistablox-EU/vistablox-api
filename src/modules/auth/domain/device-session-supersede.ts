// A successful device ceremony (E2 or L2) leaves the phone exactly one live
// session. Every other live device_biometric session of the same user that is
// bound to the same DPoP key -- the same device -- is superseded by the new
// one and revoked. Sessions bound to another key (another device), unbound
// ones (web), other authentication levels and other users' sessions are never
// touched.

/** The DPoP-key match POST /v1/auth/sessions/devices/:jkt/revoke also uses. */
export function isBoundToDpopKey(session: { dpopJkt?: unknown }, dpopJkt: string): boolean {
  return session.dpopJkt === dpopJkt;
}

/**
 * From one user's sessions, the ones a new device session supersedes: live,
 * device_biometric, bound to the same DPoP key, and not the new session
 * itself. An already-expired session is left alone; it's dead anyway.
 */
export function sessionsSupersededBy<
  T extends { token: string; dpopJkt?: unknown; authenticationLevel?: unknown; expiresAt?: unknown },
>(sessions: readonly T[], newSession: { token: string; dpopJkt: string }, now: Date): T[] {
  return sessions.filter(
    (session) =>
      session.token !== newSession.token &&
      session.authenticationLevel === "device_biometric" &&
      isBoundToDpopKey(session, newSession.dpopJkt) &&
      !hasExpired(session.expiresAt, now),
  );
}

function hasExpired(expiresAt: unknown, now: Date): boolean {
  const time =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : typeof expiresAt === "string"
        ? Date.parse(expiresAt)
        : Number.NaN;
  return Number.isFinite(time) && time <= now.getTime();
}

import { evaluateDeviceSessionLifetime } from "./device-session-lifetime.js";

/**
 * What better-auth's own session row (auth_session) says about a session.
 * That row, not the product-facing mirror in auth.sessions, is the source of
 * truth for whether a session can still authenticate (AD-171).
 */
export interface ProviderSessionFacts {
  authenticationLevel: string;
  createdAt: Date;
  /** For a device_biometric session this is its last-activity time. */
  updatedAt: Date;
  expiresAt: Date;
}

/**
 * Whether a session the mirror lists could still authenticate a request at
 * `now`. The mirror's `status` is never moved when a session simply times
 * out, so a row stays 'active' forever once its limits pass; this is the
 * check that tells a live session from a dead one.
 *
 * Same rules the request path applies:
 *
 * - a device_biometric session ends at its idle or absolute limit
 *   (evaluateDeviceSessionLifetime, computed from createdAt and updatedAt,
 *   never from expiresAt);
 * - every other session ends at better-auth's own `expiresAt`;
 * - a session whose better-auth row is gone has ended.
 *
 * The mirror's own idle_expires_at / absolute_expires_at columns are
 * deliberately not inputs: only device sessions keep them current, so for any
 * other session they would call a live session expired.
 *
 * Only a session the mirror still calls 'active' is second-guessed. Revoked
 * and other stored states are reported as stored, and a session with no
 * better-auth link has nothing to be checked against.
 */
export function canSessionStillAuthenticate(input: {
  status: string;
  betterAuthSessionId: string | null;
  providerSession: ProviderSessionFacts | null;
  now: Date;
}): boolean {
  if (input.status !== "active") return true;
  if (input.betterAuthSessionId === null) return true;

  const session = input.providerSession;
  if (session === null) return false;
  if (session.expiresAt.getTime() <= input.now.getTime()) return false;
  if (session.authenticationLevel === "device_biometric") {
    return (
      evaluateDeviceSessionLifetime({
        createdAt: session.createdAt,
        lastActivityAt: session.updatedAt,
        now: input.now,
      }).status === "active"
    );
  }
  return true;
}

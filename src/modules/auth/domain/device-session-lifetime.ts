// Session time limits for device_biometric sessions (the ones E2/L2 create),
// per contract sections 3.6/3.7 of docs/plans/device-bound-auth-backend.md:
// idle 5 min, absolute 30 min from creation, no silent renewal. When either
// limit is reached the API answers REAUTH_REQUIRED and the app runs device
// login again.
//
// Staff and web sessions do not use these limits. They keep the design
// record's web-session policy (SESSION_LIFETIME_AND_REVOCATION.md, AD-017)
// and better-auth's own expiry settings in better-auth.factory.ts.
export const DEVICE_SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEVICE_SESSION_ABSOLUTE_LIFETIME_MS = 30 * 60 * 1000;

export type DeviceSessionExpiryReason = "idle_timeout" | "absolute_lifetime";

export type DeviceSessionLifetimeVerdict =
  | { status: "active"; idleExpiresAt: Date; absoluteExpiresAt: Date }
  | { status: "expired"; reason: DeviceSessionExpiryReason };

/** The fixed end of a device session: creation time plus 30 minutes. Activity never moves it. */
export function deviceSessionAbsoluteExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + DEVICE_SESSION_ABSOLUTE_LIFETIME_MS);
}

/**
 * Decides whether a device session is still usable at `now`. A limit counts
 * as reached at its exact boundary: a session is active only while `now` is
 * strictly before both its idle expiry and its absolute expiry. The absolute
 * limit is checked first, so a session past both reports `absolute_lifetime`.
 *
 * `lastActivityAt` earlier than `createdAt` is treated as `createdAt`, since
 * no activity can predate the session. The returned `idleExpiresAt` never
 * runs past `absoluteExpiresAt`.
 */
export function evaluateDeviceSessionLifetime(input: {
  createdAt: Date;
  lastActivityAt: Date;
  now: Date;
}): DeviceSessionLifetimeVerdict {
  const absoluteExpiresAt = deviceSessionAbsoluteExpiresAt(input.createdAt);
  const now = input.now.getTime();
  if (now >= absoluteExpiresAt.getTime()) {
    return { status: "expired", reason: "absolute_lifetime" };
  }

  const lastActivity = Math.max(input.lastActivityAt.getTime(), input.createdAt.getTime());
  const idleExpiry = lastActivity + DEVICE_SESSION_IDLE_TIMEOUT_MS;
  if (now >= idleExpiry) {
    return { status: "expired", reason: "idle_timeout" };
  }

  return {
    status: "active",
    idleExpiresAt: new Date(Math.min(idleExpiry, absoluteExpiresAt.getTime())),
    absoluteExpiresAt,
  };
}

// The one rule for "this customer session confirmed who is holding it
// recently enough". /v1's requireFreshAuthentication middleware and the
// Better Auth before-hook that guards the matching /api/auth endpoints both
// ask it, so the two doors cannot drift apart.

export const FRESH_AUTH_WINDOW_MS = 5 * 60 * 1000;

export interface FreshAuthenticationSubject {
  population: string;
  authenticationLevel?: string | undefined;
  sessionCreatedAt?: Date | undefined;
}

/**
 * A customer device-biometric session is fresh for FRESH_AUTH_WINDOW_MS after
 * it was created, which is when the biometric-protected device key last signed
 * a login. Nothing else qualifies here: the DPoP key that signs every later
 * request is not biometric-gated, so it says nothing about who is holding the
 * phone now. Signing in on the device again starts a new window.
 */
export function isFreshDeviceSession(subject: FreshAuthenticationSubject, now: Date): boolean {
  return (
    subject.population === "customer" &&
    subject.authenticationLevel === "device_biometric" &&
    subject.sessionCreatedAt !== undefined &&
    subject.sessionCreatedAt.getTime() >= now.getTime() - FRESH_AUTH_WINDOW_MS
  );
}

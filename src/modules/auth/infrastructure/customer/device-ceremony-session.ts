// Sessions a device ceremony (E2/L2) deletes itself, recorded per request
// with why, so the audit plugin -- and through it the session mirror --
// records that reason instead of the request path's default (for example
// E2's ordinary "rotated" for the pending session):
// - "ceremony_failed": the ceremony failed after creating this session;
// - "superseded": a successful ceremony replaced this earlier session of the
//   same device (domain/device-session-supersede.ts).
// Keyed on the request's own auth context object, so nothing outlives the
// request and nothing leaks between requests.
export type CeremonySessionRevocationReason = "ceremony_failed" | "superseded";

const reasonsByRequest = new WeakMap<object, Map<string, CeremonySessionRevocationReason>>();

function mark(authContext: object, sessionToken: string, reason: CeremonySessionRevocationReason): void {
  const reasons = reasonsByRequest.get(authContext) ?? new Map<string, CeremonySessionRevocationReason>();
  reasons.set(sessionToken, reason);
  reasonsByRequest.set(authContext, reasons);
}

export function markDiscardedCeremonySession(authContext: object, sessionToken: string): void {
  mark(authContext, sessionToken, "ceremony_failed");
}

export function markSupersededDeviceSession(authContext: object, sessionToken: string): void {
  mark(authContext, sessionToken, "superseded");
}

/** The reason a device ceremony recorded for deleting this session in this request, if any. */
export function ceremonySessionRevocationReason(
  authContext: unknown,
  sessionToken: unknown,
): CeremonySessionRevocationReason | null {
  if (typeof authContext !== "object" || authContext === null || typeof sessionToken !== "string") {
    return null;
  }
  return reasonsByRequest.get(authContext)?.get(sessionToken) ?? null;
}

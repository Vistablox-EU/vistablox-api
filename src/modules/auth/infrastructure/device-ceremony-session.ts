// Sessions a failed device ceremony (E2/L2) created and then deleted again,
// recorded per request so the audit plugin can tell that delete apart from
// an ordinary one (e.g. E2's successful rotation of the pending session).
// Keyed on the request's own auth context object, so nothing outlives the
// request and nothing leaks between requests.
const discardedByRequest = new WeakMap<object, Set<string>>();

export function markDiscardedCeremonySession(authContext: object, sessionToken: string): void {
  const tokens = discardedByRequest.get(authContext) ?? new Set<string>();
  tokens.add(sessionToken);
  discardedByRequest.set(authContext, tokens);
}

export function isDiscardedCeremonySession(authContext: unknown, sessionToken: unknown): boolean {
  if (typeof authContext !== "object" || authContext === null || typeof sessionToken !== "string") {
    return false;
  }
  return discardedByRequest.get(authContext)?.has(sessionToken) ?? false;
}

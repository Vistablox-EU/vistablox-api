// The DPoP key a device login (L2) request verified, recorded per request so
// the audit plugin can attribute a failed L2 to the device that key belongs
// to -- never to a device_id the client merely claimed in the body. Keyed on
// the request's own auth context object, so nothing outlives the request.
const verifiedJktByRequest = new WeakMap<object, string>();

export function recordVerifiedLoginDpopJkt(authContext: object, dpopJkt: string): void {
  verifiedJktByRequest.set(authContext, dpopJkt);
}

export function verifiedLoginDpopJkt(authContext: unknown): string | null {
  if (typeof authContext !== "object" || authContext === null) return null;
  return verifiedJktByRequest.get(authContext) ?? null;
}

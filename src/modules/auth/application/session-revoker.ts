import type { IncomingHttpHeaders } from "node:http";

export interface SessionRevoker {
  revoke(token: string, headers: IncomingHttpHeaders): Promise<void>;
  /** Revokes every session belonging to the caller identified by headers, including the current one. */
  revokeAll(headers: IncomingHttpHeaders): Promise<void>;
  /**
   * Device binding (DPoP) "Remove this phone": revokes every one of the
   * caller's own sessions bound to the given key thumbprint. Scoped to the
   * caller the same way revoke/revokeAll are (re-derived from headers, not
   * an arbitrary account), so this can only ever remove the caller's own
   * device, never someone else's. Returns the number of sessions revoked.
   */
  revokeByDpopKey(jkt: string, headers: IncomingHttpHeaders): Promise<number>;
}

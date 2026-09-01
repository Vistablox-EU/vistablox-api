import type { IncomingHttpHeaders } from "node:http";

export interface SessionRevoker {
  revoke(token: string, headers: IncomingHttpHeaders): Promise<void>;
  /** Revokes every session belonging to the caller identified by headers, including the current one. */
  revokeAll(headers: IncomingHttpHeaders): Promise<void>;
}

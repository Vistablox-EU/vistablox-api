import type { IncomingHttpHeaders } from "node:http";

export interface SessionRevoker {
  revoke(token: string, headers: IncomingHttpHeaders): Promise<void>;
}

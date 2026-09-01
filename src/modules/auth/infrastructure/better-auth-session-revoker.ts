import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";

import type { SessionRevoker } from "../application/session-revoker.js";
import type { VistaBloxAuth } from "./better-auth.factory.js";

// Better Auth's own /revoke-session endpoint (auth.api.revokeSession) is
// what actually authorizes this: it re-derives "who is asking" from the
// forwarded request headers and only deletes the target token if it
// belongs to that same caller. Our own account-scoped lookup upstream of
// this call is a defense-in-depth check, not a substitute for that.
export class BetterAuthSessionRevoker implements SessionRevoker {
  public constructor(private readonly auth: VistaBloxAuth) {}

  public async revoke(token: string, headers: IncomingHttpHeaders): Promise<void> {
    await this.auth.api.revokeSession({
      headers: fromNodeHeaders(headers),
      body: { token },
    });
  }

  // Better Auth's own /revoke-sessions endpoint (auth.api.revokeSessions):
  // re-derives the caller from headers the same as revoke() above and
  // deletes every session row for that user via deleteManyWithHooks, which
  // fires the same per-session session.delete hook a single revoke does —
  // the audit trail and session mirror stay correct with no extra code here.
  public async revokeAll(headers: IncomingHttpHeaders): Promise<void> {
    await this.auth.api.revokeSessions({
      headers: fromNodeHeaders(headers),
    });
  }
}

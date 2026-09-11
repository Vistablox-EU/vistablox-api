import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import type { Pool } from "pg";

import type { SessionResolver, AuthenticatedIdentity } from "../application/session-resolver.js";
import type { VistaBloxAuth } from "./better-auth.factory.js";

export class BetterAuthSessionResolver implements SessionResolver {
  public constructor(
    private readonly auth: VistaBloxAuth,
    // Better Auth's own session table (auth_session) has no generic "update
    // an arbitrary field" API surface, so the one write this resolver needs
    // -- bindDpopKey, an opportunistic bind outside the create hook -- goes
    // straight at the table it already owns, the same connection Better
    // Auth itself uses.
    private readonly authPool: Pool,
    private readonly options: { allowPendingOAuth?: boolean } = {},
  ) {}

  public async resolve(headers: IncomingHttpHeaders): Promise<AuthenticatedIdentity | null> {
    const result = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (result === null) {
      return null;
    }
    if (result.user.disabledAt != null || result.user.recoveryRequiredAt != null) {
      return null;
    }
    const authenticationLevel = result.session.authenticationLevel;
    const accepted =
      authenticationLevel === "oauth_passkey" ||
      authenticationLevel === "staff_passkey" ||
      authenticationLevel === "device_biometric" ||
      (this.options.allowPendingOAuth === true && authenticationLevel === "oauth_pending");
    if (!accepted) return null;

    const dpopJkt = (result.session as Record<string, unknown>).dpopJkt;
    return {
      betterAuthUserId: result.user.id,
      providerSessionId: result.session.id,
      population: result.user.population === "staff_partner" ? "staff_partner" : "customer",
      dpopJkt: typeof dpopJkt === "string" ? dpopJkt : null,
      sessionCreatedAt: result.session.createdAt,
    };
  }

  public async bindDpopKey(providerSessionId: string, jkt: string): Promise<void> {
    await this.authPool.query('UPDATE "auth_session" SET "dpopJkt" = $1 WHERE "id" = $2', [
      jkt,
      providerSessionId,
    ]);
  }
}

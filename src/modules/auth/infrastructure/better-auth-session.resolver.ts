import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";

import type { SessionResolver, AuthenticatedIdentity } from "../application/session-resolver.js";
import type { VistaBloxAuth } from "./better-auth.factory.js";

export class BetterAuthSessionResolver implements SessionResolver {
  public constructor(
    private readonly auth: VistaBloxAuth,
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
      (this.options.allowPendingOAuth === true && authenticationLevel === "oauth_pending");
    if (!accepted) return null;

    return {
      betterAuthUserId: result.user.id,
      providerSessionId: result.session.id,
      population: result.user.population === "staff_partner" ? "staff_partner" : "customer",
    };
  }
}

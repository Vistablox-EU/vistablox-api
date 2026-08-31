import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";

import type { SessionResolver, AuthenticatedIdentity } from "../application/session-resolver.js";
import type { VistaBloxAuth } from "./better-auth.factory.js";

export class BetterAuthSessionResolver implements SessionResolver {
  public constructor(private readonly auth: VistaBloxAuth) {}

  public async resolve(headers: IncomingHttpHeaders): Promise<AuthenticatedIdentity | null> {
    const result = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (result === null) {
      return null;
    }

    return {
      betterAuthUserId: result.user.id,
      providerSessionId: result.session.id,
      population: result.user.population === "staff_partner" ? "staff_partner" : "customer",
    };
  }
}
